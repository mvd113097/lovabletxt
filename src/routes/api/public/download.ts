import { createFileRoute } from "@tanstack/react-router";

// GET /api/public/download?id=<novel>&format=epub|txt&t=<token>
// Only includes chapters 1..N with no gaps, always in chapter order.
export const Route = createFileRoute("/api/public/download")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const id = url.searchParams.get("id") ?? "";
        const format = url.searchParams.get("format") === "txt" ? "txt" : "epub";
        const { requireToken } = await import("@/lib/auth.server");
        try {
          await requireToken(url.searchParams.get("t"));
        } catch {
          return new Response("Unauthorized", { status: 401 });
        }
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { data: novel } = await supabaseAdmin.from("novels").select("title").eq("id", id).maybeSingle();
        if (!novel) return new Response("Not found", { status: 404 });

        const chapters: { idx: number; title: string; text: string }[] = [];
        const PAGE = 200;
        for (let from = 0; ; from += PAGE) {
          const { data, error } = await supabaseAdmin
            .from("chapters")
            .select("idx, status, translated_title, translated_text")
            .eq("novel_id", id)
            .order("idx")
            .range(from, from + PAGE - 1);
          if (error) return new Response(error.message, { status: 500 });
          let stop = false;
          for (const c of data ?? []) {
            if (c.status !== "done" || c.idx !== chapters.length) {
              stop = true;
              break;
            }
            chapters.push({ idx: c.idx, title: c.translated_title ?? "", text: c.translated_text ?? "" });
          }
          if (stop || (data?.length ?? 0) < PAGE) break;
        }
        if (!chapters.length) return new Response("No finished chapters yet", { status: 409 });

        const safe = novel.title.replace(/[^\p{L}\p{N} _-]+/gu, "").trim() || "novel";
        const name = `${safe} (ch 1-${chapters.length}).${format}`;
        const disp = `attachment; filename="novel.${format}"; filename*=UTF-8''${encodeURIComponent(name)}`;
        if (format === "txt") {
          const txt = chapters.map((c, i) => `${c.title || `Chapter ${i + 1}`}\n\n${c.text}`).join("\n\n\n");
          return new Response(txt, {
            headers: { "content-type": "text/plain; charset=utf-8", "content-disposition": disp },
          });
        }
        const { buildEpub } = await import("@/lib/epub.server");
        const bytes = buildEpub(novel.title, chapters);
        return new Response(bytes, {
          headers: { "content-type": "application/epub+zip", "content-disposition": disp },
        });
      },
    },
  },
});
