import { describe, it, expect, afterEach } from "vitest";
import { parallelChapters, KEY_GAP_MS } from "@/lib/translate.server";

describe("parallel translation", () => {
  afterEach(() => {
    delete process.env["GEMINI_API_KEYS"];
  });
  it("translates one chapter per key at once", () => {
    process.env["GEMINI_API_KEYS"] = "AQ.a,AQ.b,AQ.c,AQ.d,AQ.e";
    expect(parallelChapters()).toBe(5);
  });
  it("never uses one key more than 10 times a minute", () => {
    expect(60_000 / KEY_GAP_MS).toBeLessThanOrEqual(10);
  });
});
