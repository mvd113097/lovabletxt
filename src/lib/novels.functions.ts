import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const tok = z.object({ t: z.string().nullable() });

export const authStatus = createServerFn({ method: "POST" })
  .inputValidator((d) => tok.parse(d))
  .handler(async ({ data }) => {
    const { getSettings, makeToken } = await import("./auth.server");
    const s = await getSettings();
    if (!s.passcode_hash) return { state: "setup" as const };
    const ok = !!data.t && data.t === (await makeToken(s.passcode_hash));
    return { state: ok ? ("ok" as const) : ("locked" as const) };
  });

export const login = createServerFn({ method: "POST" })
  .inputValidator((d) => z.object({ pin: z.string().min(4).max(64) }).parse(d))
  .handler(async ({ data }) => {
    const { getSettings, hashPasscode, makeToken } = await import("./auth.server");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const s = await getSettings();
    if (!s.passcode_hash) {
      const h = await hashPasscode(data.pin);
      const { data: upd } = await supabaseAdmin
        .from("app_settings")
        .update({ passcode_hash: h })
        .eq("id", 1)
        .is("passcode_hash", null)
        .select("id");
      if (!upd?.length) throw new Error("Passcode already set");
      return { token: await makeToken(h) };
    }
    const [salt] = s.passcode_hash.split(":");
    if ((await hashPasscode(data.pin, salt)) !== s.passcode_hash) throw new Error("Wrong passcode");
    return { token: await makeToken(s.passcode_hash) };
  });

export const createNovel = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z.object({ t: z.string(), title: z.string().min(1).max(300), total: z.number().int().min(1).max(20000) }).parse(d),
  )
  .handler(async ({ data }) => {
    const { requireToken } = await import("./auth.server");
    await requireToken(data.t);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: n, error } = await supabaseAdmin
      .from("novels")
      .insert({ title: data.title, total_chapters: data.total, status: "paused" })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return { id: n.id };
  });

export const addChapters = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z
      .object({
        t: z.string(),
        novelId: z.string().uuid(),
        chapters: z
          .array(z.object({ idx: z.number().int().min(0), title: z.string().max(500), text: z.string().min(1).max(200000) }))
          .max(200),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const { requireToken } = await import("./auth.server");
    await requireToken(data.t);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.from("chapters").upsert(
      data.chapters.map((c) => ({ novel_id: data.novelId, idx: c.idx, title: c.title, source_text: c.text })),
      { onConflict: "novel_id,idx", ignoreDuplicates: true },
    );
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const setNovelStatus = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z.object({ t: z.string(), novelId: z.string().uuid(), action: z.enum(["start", "pause", "delete"]) }).parse(d),
  )
  .handler(async ({ data }) => {
    const { requireToken } = await import("./auth.server");
    await requireToken(data.t);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    if (data.action === "delete") {
      await supabaseAdmin.from("novels").delete().eq("id", data.novelId);
      return { ok: true };
    }
    if (data.action === "start") {
      const { count } = await supabaseAdmin
        .from("chapters")
        .select("idx", { count: "exact", head: true })
        .eq("novel_id", data.novelId);
      const { data: n } = await supabaseAdmin.from("novels").select("total_chapters").eq("id", data.novelId).single();
      if (!n || count !== n.total_chapters) throw new Error("Upload is incomplete. Please upload the file again.");
      await supabaseAdmin.from("novels").update({ status: "running" }).eq("id", data.novelId).neq("status", "done");
      const { error } = await supabaseAdmin.rpc("ensure_tick");
      if (error) throw new Error(error.message);
    } else {
      await supabaseAdmin.from("novels").update({ status: "paused" }).eq("id", data.novelId).eq("status", "running");
    }
    return { ok: true };
  });

export const listNovels = createServerFn({ method: "POST" })
  .inputValidator((d) => z.object({ t: z.string() }).parse(d))
  .handler(async ({ data }) => {
    const { requireToken } = await import("./auth.server");
    await requireToken(data.t);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const [{ data: novels }, { data: prog }] = await Promise.all([
      supabaseAdmin.from("novels").select("id,title,status,total_chapters,created_at").order("created_at", { ascending: false }),
      supabaseAdmin.rpc("novel_progress"),
    ]);
    const map = new Map((prog ?? []).map((p) => [p.novel_id, p]));
    return (novels ?? []).map((n) => {
      const p = map.get(n.id);
      return {
        id: n.id,
        title: n.title,
        status: n.status,
        total: n.total_chapters,
        uploaded: p?.total ?? 0,
        done: p?.done ?? 0,
        google: p?.google ?? 0,
        ready: p?.ready ?? 0,
        readyWords: Number(p?.ready_words ?? 0),
        lastError: p?.last_error ?? null,
        chunksTotal: Number((p as any)?.chunks_total ?? 0),
        chunksDone: Number((p as any)?.chunks_done ?? 0),
      };
    });
  });

export const getSettingsFn = createServerFn({ method: "POST" })
  .inputValidator((d) => z.object({ t: z.string() }).parse(d))
  .handler(async ({ data }) => {
    const { requireToken } = await import("./auth.server");
    const s = await requireToken(data.t);
    const x = s as any;
    return {
      telegramChatId: s.telegram_chat_id ?? "",
      telegramConnected: !!process.env["TELEGRAM_API_KEY"],
      notifyStatus: x.notify_status !== false,
      notifyDone: x.notify_done !== false,
    };
  });

export const saveSettings = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z
      .object({ t: z.string(), telegramChatId: z.string().max(300),
        notifyStatus: z.boolean().optional(),
        notifyDone: z.boolean().optional(),
        newPin: z.string().min(4).max(64).optional() })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const { requireToken, hashPasscode, makeToken } = await import("./auth.server");
    await requireToken(data.t);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const ids = data.telegramChatId.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
    const patch: { telegram_chat_id: string | null; notify_status?: boolean; notify_done?: boolean; passcode_hash?: string } = { telegram_chat_id: ids.join(",") || null };
    if (data.notifyStatus !== undefined) patch.notify_status = data.notifyStatus;
    if (data.notifyDone !== undefined) patch.notify_done = data.notifyDone;
    if (data.newPin) patch.passcode_hash = await hashPasscode(data.newPin);
    await supabaseAdmin.from("app_settings").update(patch as any).eq("id", 1);
    return { token: patch.passcode_hash ? await makeToken(patch.passcode_hash) : data.t };
  });

export const testTelegram = createServerFn({ method: "POST" })
  .inputValidator((d) => z.object({ t: z.string() }).parse(d))
  .handler(async ({ data }) => {
    const { requireToken } = await import("./auth.server");
    await requireToken(data.t);
    const { sendTelegram } = await import("./worker.server");
    const fails = await sendTelegram("👋 MegaTXT test message — alerts are working.");
    return { ok: !fails.length, fails };
  });
