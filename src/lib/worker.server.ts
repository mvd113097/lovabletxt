import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { CreditsError, parallelChapters, translateChapter } from "./translate.server";
import { getSettings } from "./auth.server";

export async function sendTelegram(text: string) {
  const lovable = process.env["LOVABLE_API_KEY"];
  const tg = process.env["TELEGRAM_API_KEY"];
  if (!lovable || !tg) return;
  const s = await getSettings();
  if (!s.telegram_chat_id) return;
  const r = await fetch("https://connector-gateway.lovable.dev/telegram/sendMessage", {
    method: "POST",
    headers: { Authorization: `Bearer ${lovable}`, "X-Connection-Api-Key": tg, "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: s.telegram_chat_id, text }),
  });
  if (!r.ok) console.error(`Telegram failed [${r.status}]: ${await r.text()}`);
}

async function finishCheck(novelId: string) {
  const { count } = await supabaseAdmin
    .from("chapters")
    .select("idx", { count: "exact", head: true })
    .eq("novel_id", novelId)
    .neq("status", "done");
  if (count !== 0) return;
  const { data } = await supabaseAdmin
    .from("novels")
    .update({ status: "done", finished_at: new Date().toISOString(), notified: true })
    .eq("id", novelId)
    .eq("notified", false)
    .select("title")
    .maybeSingle();
  if (data) await sendTelegram(`✅ "${data.title}" finished translating. Open MegaTXT to download the EPUB.`);
}

async function processOne(ch: { novel_id: string; idx: number; title: string; source_text: string; partial?: unknown }) {
  try {
    const r = await translateChapter(ch.title, ch.source_text, (ch.partial ?? {}) as any, async (p) => {
      // Save each finished piece and refresh the lock so a long chapter isn't re-claimed mid-way.
      await supabaseAdmin
        .from("chapters")
        .update({ partial: p as any, locked_at: new Date().toISOString() })
        .eq("novel_id", ch.novel_id)
        .eq("idx", ch.idx);
    });
    await supabaseAdmin
      .from("chapters")
      .update({
        status: "done",
        translated_title: r.title,
        translated_text: r.text,
        engine: r.usedGoogle ? "google" : "gemini",
        word_count: r.words,
        last_error: null,
        locked_at: null,
        partial: {},
      })
      .eq("novel_id", ch.novel_id)
      .eq("idx", ch.idx);
    await finishCheck(ch.novel_id);
  } catch (e) {
    const msg = (e as Error).message.slice(0, 300);
    // Never skip a chapter: put it back in the queue for the next run.
    await supabaseAdmin
      .from("chapters")
      .update({ status: "pending", locked_at: null, last_error: msg })
      .eq("novel_id", ch.novel_id)
      .eq("idx", ch.idx);
    if (e instanceof CreditsError) {
      await supabaseAdmin.from("novels").update({ status: "paused" }).eq("status", "running");
      await sendTelegram("⚠️ MegaTXT paused: AI credits ran out. Add credits, then press Resume.");
    }
    throw e;
  }
}

/** Runs translation for up to ~40 seconds. Called by the once-a-minute schedule. */
export async function runTick() {
  const started = Date.now();
  let processed = 0;
  while (Date.now() - started < 35_000) {
    const { data: claimed, error } = await supabaseAdmin.rpc("claim_chapters", { _limit: parallelChapters() });
    if (error) throw new Error(error.message);
    if (!claimed?.length) break;
    const results = await Promise.allSettled(claimed.map(processOne));
    processed += results.filter((r) => r.status === "fulfilled").length;
    if (results.some((r) => r.status === "rejected" && (r.reason instanceof CreditsError))) break;
    if (results.every((r) => r.status === "rejected")) break; // back off until next minute
  }
  // Stop the schedule once nothing is left to translate.
  const { count } = await supabaseAdmin
    .from("chapters")
    .select("idx, novels!inner(status)", { count: "exact", head: true })
    .neq("status", "done")
    .eq("novels.status", "running");
  if (!count) await supabaseAdmin.rpc("stop_tick");
  return { processed, remaining: count ?? 0 };
}
