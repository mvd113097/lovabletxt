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
