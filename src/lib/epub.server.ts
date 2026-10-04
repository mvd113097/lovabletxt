import { zipSync, strToU8 } from "fflate";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export type EpubChapter = { idx: number; title: string; text: string };

export function buildEpub(bookTitle: string, chapters: EpubChapter[]): Uint8Array {
  const id = `megatxt-${Date.now()}`;
  const files: Record<string, Uint8Array | [Uint8Array, { level: 0 }]> = {};
  files["mimetype"] = [strToU8("application/epub+zip"), { level: 0 }];
  files["META-INF/container.xml"] = strToU8(
    `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
  );
  const sorted = [...chapters].sort((a, b) => a.idx - b.idx);
  const items: string[] = [];
  const spine: string[] = [];
  const nav: string[] = [];
  sorted.forEach((c, n) => {
    const name = `c${String(n + 1).padStart(5, "0")}.xhtml`;
    const title = c.title?.trim() || `Chapter ${n + 1}`;
    const body = c.text
      .split(/\n+/)
      .filter((p) => p.trim())
      .map((p) => `<p>${esc(p.trim())}</p>`)
      .join("\n");
    files[`OEBPS/${name}`] = strToU8(
      `<?xml version="1.0" encoding="utf-8"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${esc(title)}</title></head><body><h2>${esc(title)}</h2>\n${body}</body></html>`,
    );
    items.push(`<item id="c${n}" href="${name}" media-type="application/xhtml+xml"/>`);
    spine.push(`<itemref idref="c${n}"/>`);
    nav.push(`<li><a href="${name}">${esc(title)}</a></li>`);
  });
  files["OEBPS/nav.xhtml"] = strToU8(
    `<?xml version="1.0" encoding="utf-8"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><h1>Contents</h1><ol>${nav.join("")}</ol></nav></body></html>`,
  );
  files["OEBPS/content.opf"] = strToU8(
    `<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="bid">${id}</dc:identifier><dc:title>${esc(bookTitle)}</dc:title><dc:language>en</dc:language><meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d+Z$/, "Z")}</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${items.join("")}</manifest><spine>${spine.join("")}</spine></package>`,
  );
  return zipSync(files as any, { level: 6 });
}
