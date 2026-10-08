import { describe, expect, it } from "vitest";
import { FREE_MODELS, retryDelayMs } from "@/lib/translate.server";

describe("free Gemini quota handling", () => {
  it("tries flash-lite first (largest free daily quota)", () => {
    expect(FREE_MODELS[0]).toBe("gemini-3.1-flash-lite");
  });
  it("waits as long as Google asks, plus 1s", () => {
    expect(retryDelayMs('{"retryDelay": "17s"}')).toBe(18000);
    expect(retryDelayMs("no hint")).toBeNull();
  });
});

import { packChunks } from "@/lib/translate.server";
describe("packChunks", () => {
  const lines = Array.from({ length: 200 }, (_, i) => "字".repeat(100 + ((i * 37) % 300)));
  const r = packChunks(lines, 9000);
  const sizes = r.map(([a, b]) => lines.slice(a, b).join("").length);
  it("keeps every line once, in order", () => {
    expect(r[0]![0]).toBe(0);
    r.forEach(([, b], k) => k < r.length - 1 && expect(r[k + 1]![0]).toBe(b));
    expect(r.at(-1)![1]).toBe(200);
  });
  it("never exceeds 9000 chars and uses the fewest requests", () => {
    const total = lines.join("").length;
    expect(Math.max(...sizes)).toBeLessThanOrEqual(9000);
    expect(r.length).toBeLessThanOrEqual(Math.ceil(total / 9000) + 1);
  });
  it("has no tiny tail piece", () => {
    expect(Math.min(...sizes)).toBeGreaterThan(Math.max(...sizes) * 0.9);
  });
});
