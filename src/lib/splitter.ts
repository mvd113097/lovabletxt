// Splits a raw novel TXT into ordered chapters. Pure, runs in the browser.
export type RawChapter = { idx: number; title: string; text: string };

const HEADING =
  /^\s*(第\s*[0-9零〇一二两三四五六七八九十百千万]+\s*[章节回卷][^\n]{0,40}|chapter\s+\d+[^\n]{0,60}|序章[^\n]{0,30}|楔子[^\n]{0,30}|番外[^\n]{0,40})\s*$/i;

const MAX_CHARS = 30000; // very long "chapters" are split so each piece translates reliably

export function decodeNovel(buf: ArrayBuffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf).replace(/^\uFEFF/, "");
  } catch {
    return new TextDecoder("gb18030").decode(buf);
  }
}

export function splitChapters(raw: string): RawChapter[] {
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");
  const out: { title: string; lines: string[] }[] = [];
  let cur: { title: string; lines: string[] } = { title: "", lines: [] };
  for (const line of lines) {
    if (HEADING.test(line)) {
      if (cur.title || cur.lines.some((l) => l.trim())) out.push(cur);
      cur = { title: line.trim(), lines: [] };
    } else cur.lines.push(line);
  }
  if (cur.title || cur.lines.some((l) => l.trim())) out.push(cur);

  const result: RawChapter[] = [];
  for (const c of out) {
    const paras = c.lines.map((l) => l.trim()).filter(Boolean);
    if (!paras.length) {
      if (c.title) result.push({ idx: 0, title: c.title, text: c.title });
      continue;
    }
    let part: string[] = [];
    let len = 0;
    let n = 0;
    const flush = () => {
      if (!part.length) return;
      result.push({ idx: 0, title: n === 0 ? c.title : `${c.title} (${n + 1})`.trim(), text: part.join("\n") });
      n++;
      part = [];
      len = 0;
    };
    for (const p of paras) {
      if (len + p.length > MAX_CHARS) flush();
      part.push(p);
      len += p.length;
    }
    flush();
  }
  return result.map((c, i) => ({ ...c, idx: i }));
}
