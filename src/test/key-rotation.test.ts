import { afterEach, expect, it, vi } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import { buildEpub } from "@/lib/epub.server";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.resetModules();
});

async function engine(keys: string) {
  vi.resetModules();
  vi.stubEnv("GEMINI_API_KEYS", keys);
  vi.stubEnv("GEMINI_API_KEY_EXTRA", "");
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-03T07:00:00Z"));
  return import("@/lib/translate.server");
}

function reply() {
  return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{
    text: "[[0]] Homecoming\n[[1]] Lin Qing opened the door.\n[[2]] He gave his sister the last cake.",
  }] } }] });
}

it.each([400, 401, 403])("skips explicitly invalid credentials (%s) across models and later chapters", async (status) => {
  const { translateChapter } = await engine("bad,good");
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    const key = init.headers["x-goog-api-key"];
    calls.push(key);
    return key === "bad" ? Response.json({ error: { reason: "API_KEY_INVALID" } }, { status }) : reply();
  }));
  const first = translateChapter("归来", "林青推开门。\n他把最后一块饼给了妹妹。");
  await vi.runAllTimersAsync();
  await first;
  const second = translateChapter("归来", "林青推开门。\n他把最后一块饼给了妹妹。");
  await vi.runAllTimersAsync();
  await second;
  expect(calls).toEqual(["bad", "good", "good"]);
});

it("does not permanently disable a key for model-specific 403 permissions", async () => {
  const { translateChapter } = await engine("good");
  const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ error: { message: "Permission denied for this model" } }, { status: 403 }))
    .mockImplementation(async () => reply());
  vi.stubGlobal("fetch", fetchMock);
  const pending = translateChapter("归来", "林青推开门。\n他把最后一块饼给了妹妹。");
  await vi.runAllTimersAsync();
  expect((await pending).usedGoogle).toBe(false);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("distributes ten parallel chapters across five keys, keeps six-second gaps, and preserves every EPUB paragraph", async () => {
  const { translateChapter } = await engine("a,b,c,d,e");
  const calls: { key: string; time: number }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    calls.push({ key: init.headers["x-goog-api-key"], time: Date.now() });
    return reply();
  }));
  const pending = Promise.all(Array.from({ length: 10 }, () => translateChapter("归来", "林青推开门。\n他把最后一块饼给了妹妹。")));
  await vi.runAllTimersAsync();
  const results = await pending;
  expect(calls.slice(0, 5).map((c) => c.key)).toEqual(["a", "b", "c", "d", "e"]);
  expect(new Set(calls.slice(0, 5).map((c) => c.time)).size).toBe(1);
  for (const key of ["a", "b", "c", "d", "e"]) {
    const times = calls.filter((c) => c.key === key).map((c) => c.time);
    expect(times).toHaveLength(2);
    expect((times[1] ?? 0) - (times[0] ?? 0)).toBeGreaterThanOrEqual(6000);
  }
  const files = unzipSync(buildEpub("Novel", results.map((r, idx) => ({ idx, title: r.title, text: r.text }))));
  expect(Object.keys(files).filter((p) => /c\d+\.xhtml$/.test(p))).toHaveLength(10);
  results.forEach((r, idx) => {
    expect(r.usedGoogle).toBe(false);
    expect(r.text.split("\n\n")).toEqual(["Lin Qing opened the door.", "He gave his sister the last cake."]);
    const chapter = files[`OEBPS/c${String(idx + 1).padStart(5, "0")}.xhtml`];
    if (!chapter) throw new Error("EPUB chapter missing");
    expect(strFromU8(chapter).match(/<p>(.*?)<\/p>/g)).toEqual(["<p>Lin Qing opened the door.</p>", "<p>He gave his sister the last cake.</p>"]);
  });
});

it("honors a 429 retryDelay instead of disabling the key or sending requests during cooldown", async () => {
  const { translateChapter } = await engine("good");
  const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ retryDelay: "17s" }, { status: 429 }))
    .mockResolvedValueOnce(Response.json({ retryDelay: "17s" }, { status: 429 }))
    .mockImplementation(async () => reply());
  vi.stubGlobal("fetch", fetchMock);
  const pending = translateChapter("归来", "林青推开门。\n他把最后一块饼给了妹妹。");
  const failure = expect(pending).rejects.toThrow();
  await vi.runAllTimersAsync();
  await failure;
  await expect(translateChapter("归来", "林青推开门。")).rejects.toThrow();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(18000);
  const resumed = translateChapter("归来", "林青推开门。\n他把最后一块饼给了妹妹。");
  await vi.runAllTimersAsync();
  expect((await resumed).usedGoogle).toBe(false);
  expect(fetchMock).toHaveBeenCalledTimes(3);
});