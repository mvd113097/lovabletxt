import { afterEach, expect, it, vi } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import { buildEpub } from "@/lib/epub.server";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.resetModules();
});

it("falls back from busy 3.5 Lite to 3.1 Lite while keeping all paragraphs in the EPUB", async () => {
  vi.resetModules();
  vi.stubEnv("GEMINI_API_KEYS", "test-key");
  vi.stubEnv("GEMINI_API_KEY_EXTRA", "");
  vi.useFakeTimers();
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(new Response("Busy", { status: 503 }))
    .mockResolvedValueOnce(Response.json({ candidates: [{
      finishReason: "STOP",
      content: { parts: [{ text: "[[0]] Homecoming\n[[1]] Lin Qing opened the door.\n[[2]] He gave his sister the last cake." }] },
    }] }));
  vi.stubGlobal("fetch", fetchMock);
  const { translateChapter } = await import("@/lib/translate.server");
  const pending = translateChapter("归来", "林青推开门。\n他把最后一块饼给了妹妹。");
  await vi.runAllTimersAsync();
  const result = await pending;
  expect(fetchMock.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
    "/v1beta/models/gemini-3.5-flash-lite:generateContent",
    "/v1beta/models/gemini-3.1-flash-lite:generateContent",
  ]);
  expect(result.usedGoogle).toBe(false);
  expect(result.title).toBe("Homecoming");
  expect(result.text.split("\n\n")).toEqual([
    "Lin Qing opened the door.", "He gave his sister the last cake.",
  ]);
  const files = unzipSync(buildEpub("Test novel", [{ idx: 0, title: result.title, text: result.text }]));
  const chapter = files["OEBPS/c00001.xhtml"];
  if (!chapter) throw new Error("EPUB chapter missing");
  expect(strFromU8(chapter).match(/<p>(.*?)<\/p>/g)).toEqual([
    "<p>Lin Qing opened the door.</p>", "<p>He gave his sister the last cake.</p>",
  ]);
});