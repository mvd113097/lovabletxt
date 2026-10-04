import { describe, it, expect } from "vitest";
import { splitChapters } from "@/lib/splitter";
import { parseMarked } from "@/lib/translate.server";

describe("splitChapters", () => {
  it("keeps chapters in file order and every paragraph", () => {
    const raw = "简介一段\n第1章 开始\n甲\n乙\n第2章 继续\n丙\n\n丁\n第10章 结束\n戊";
    const ch = splitChapters(raw);
    expect(ch.map((c) => c.idx)).toEqual([0, 1, 2, 3]);
    expect(ch.map((c) => c.title)).toEqual(["", "第1章 开始", "第2章 继续", "第10章 结束"]);
    expect(ch[2]?.text).toBe("丙\n丁");
    const all = ch.map((c) => c.text).join("\n");
    for (const p of ["简介一段", "甲", "乙", "丙", "丁", "戊"]) expect(all).toContain(p);
  });

  it("splits a huge chapter without losing paragraphs", () => {
    const paras = Array.from({ length: 100 }, (_, i) => `段${i}` + "字".repeat(500));
    const ch = splitChapters("第1章 长\n" + paras.join("\n"));
    expect(ch.length).toBeGreaterThan(1);
    expect(ch.flatMap((c) => c.text.split("\n"))).toEqual(paras);
  });
});

describe("parseMarked", () => {
  it("maps every marker to its line", () => {
    const m = parseMarked("[[0]] Title\n[[1]] First line.\n[[2]] Second\nline wrap");
    expect(m.get(0)).toBe("Title");
    expect(m.get(1)).toBe("First line.");
    expect(m.get(2)).toBe("Second\nline wrap");
  });
});
