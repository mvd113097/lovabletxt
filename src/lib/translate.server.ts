// Translation engine: Gemini first; Google Translate ONLY for parts Gemini refuses on safety grounds.
export const GEMINI_MODEL = "google/gemini-3.1-flash-lite";
const MAX_CHUNK_CHARS = 4500;

export class BlockedError extends Error {}
export class TransientError extends Error {}
export class CreditsError extends Error {}

const SAFETY_RE = /safety|blocked|prohibited|content[_ ]?filter|recitation|harm_category|policy/i;

const SYSTEM = `You translate Chinese web novels into fluent, natural English.
Rules:
- Every input line starts with a marker like [[12]]. Output EVERY marker exactly once, in the same order, each on its own line followed by the English translation of that line.
- Never merge, skip, summarize or add lines. Never add notes or commentary.
- Keep names consistent and use pinyin for names.`;

// User's own Gemini keys (GEMINI_API_KEYS, comma-separated). Rotated per call; a rate-limited key is skipped.
export const OWN_GEMINI_MODEL = "gemini-3.8-flash";
let keyCursor = 0;
const cooldown = new Map<string, number>();

function ownKeys() {
  return (process.env["GEMINI_API_KEYS"] ?? process.env["GEMINI_API_KEY"] ?? "")
    .split(/[,\s]+/)
    .map((k) => k.trim())
    .filter(Boolean);
}

async function ownGeminiCall(keys: string[], input: string): Promise<Map<number, string>> {
  const now = Date.now();
  let lastErr = "";
  for (let n = 0; n < keys.length; n++) {
    const key = keys[(keyCursor++) % keys.length]!;
    if ((cooldown.get(key) ?? 0) > now) continue;
    let res: Response;
    try {
      res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${OWN_GEMINI_MODEL}:generateContent`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": key },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: SYSTEM }] },
            contents: [{ role: "user", parts: [{ text: input }] }],
            generationConfig: { temperature: 0.3, thinkingConfig: { thinkingLevel: "low" } },
            safetySettings: [
              "HARM_CATEGORY_HARASSMENT",
              "HARM_CATEGORY_HATE_SPEECH",
              "HARM_CATEGORY_SEXUALLY_EXPLICIT",
              "HARM_CATEGORY_DANGEROUS_CONTENT",
            ].map((category) => ({ category, threshold: "BLOCK_NONE" })),
          }),
        },
      );
    } catch (e) {
      lastErr = `network: ${(e as Error).message}`;
      continue;
    }
    const body = await res.text();
    if (res.status === 429 || res.status === 403 || res.status >= 500) {
      cooldown.set(key, now + (res.status === 403 ? 600_000 : res.status === 429 ? 60_000 : 20_000));
      lastErr = `gemini key ${res.status}`;
      continue; // try the next key
    }
    if (!res.ok) {
      if (SAFETY_RE.test(body)) throw new BlockedError(`gemini ${res.status}`);
      if (res.status === 400 || res.status === 401) cooldown.set(key, now + 600_000); // bad/expired key: skip for 10 min
      lastErr = `gemini ${res.status}: ${body.slice(0, 150)}`;
      continue;
    }
    const json = JSON.parse(body);
    if (json.promptFeedback?.blockReason) throw new BlockedError(`blocked: ${json.promptFeedback.blockReason}`);
    const cand = json.candidates?.[0];
    const finish = String(cand?.finishReason ?? "");
    const text: string = (cand?.content?.parts ?? []).map((p: any) => p.text ?? "").join("");
    if (/SAFETY|PROHIBITED|BLOCKLIST|SPII|RECITATION/.test(finish)) throw new BlockedError(`refused: ${finish}`);
    if (!text.trim()) {
      lastErr = `empty reply (${finish})`;
      continue;
    }
    return parseMarked(text);
  }
  throw new TransientError(lastErr || "all Gemini keys busy");
}

async function geminiCall(lines: string[], startNo: number): Promise<Map<number, string>> {
  const input = lines.map((l, i) => `[[${startNo + i}]] ${l}`).join("\n");
  const keys = ownKeys();
  if (keys.length) return ownGeminiCall(keys, input);
  const key = process.env["LOVABLE_API_KEY"];
  if (!key) throw new Error("LOVABLE_API_KEY missing");
  let res: Response;
  try {
    res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: GEMINI_MODEL,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: input },
        ],
      }),
    });
  } catch (e) {
    throw new TransientError(`network: ${(e as Error).message}`);
  }
  const body = await res.text();
  if (res.status === 402) throw new CreditsError("AI credits ran out");
  if (res.status === 429 || res.status >= 500) throw new TransientError(`gemini ${res.status}`);
  if (!res.ok) {
    if (SAFETY_RE.test(body)) throw new BlockedError(`gemini ${res.status}: ${body.slice(0, 200)}`);
    throw new TransientError(`gemini ${res.status}: ${body.slice(0, 200)}`);
  }
  let json: any;
  try {
    json = JSON.parse(body);
  } catch {
    throw new TransientError("bad gemini response");
  }
  const choice = json.choices?.[0];
  const finish = String(choice?.finish_reason ?? choice?.native_finish_reason ?? "");
  const text: string = choice?.message?.content ?? "";
  if (SAFETY_RE.test(finish) || (!text.trim() && SAFETY_RE.test(JSON.stringify(json)))) {
    throw new BlockedError(`gemini refused (${finish})`);
  }
  return parseMarked(text);
}

export function parseMarked(text: string): Map<number, string> {
  const out = new Map<number, string>();
  const re = /\[\[(\d+)\]\]\s*([\s\S]*?)(?=\n?\s*\[\[\d+\]\]|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const t = (m[2] ?? "").trim();
    if (t) out.set(Number(m[1]), t);
  }
  return out;
}

async function googleOne(text: string): Promise<string> {
  const res = await fetch("https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=t", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body: "q=" + encodeURIComponent(text),
  });
  if (!res.ok) throw new TransientError(`google ${res.status}`);
  const data = (await res.json()) as any;
  return (data?.[0] ?? []).map((x: any) => x?.[0] ?? "").join("");
}

/** Google Translate a list of lines, guaranteeing one output per input line. */
export async function googleLines(lines: string[]): Promise<string[]> {
  const out: string[] = [];
  let group: string[] = [];
  const flush = async () => {
    if (!group.length) return;
    const joined = await googleOne(group.join("\n"));
    const parts = joined.split("\n").map((s) => s.trim());
    if (parts.length === group.length) out.push(...parts);
    else for (const g of group) out.push((await googleOne(g)).trim());
    group = [];
  };
  for (const l of lines) {
    if (group.join("\n").length + l.length > 3500) await flush();
    group.push(l);
  }
  await flush();
  return out;
}

/** Translate lines with Gemini; returns translations + whether Google was needed. */
async function translateChunk(lines: string[], startNo: number): Promise<{ out: string[]; usedGoogle: boolean }> {
  try {
    let map = await geminiCall(lines, startNo);
    let missing = lines.map((_, i) => startNo + i).filter((n) => !map.has(n));
    if (missing.length) {
      // One repair pass for any skipped lines, still with Gemini.
      const repair = await geminiCall(missing.map((n) => lines[n - startNo]!), 100000);
      missing.forEach((n, i) => {
        const t = repair.get(100000 + i);
        if (t) map.set(n, t);
      });
      missing = missing.filter((n) => !map.has(n));
      if (missing.length) throw new TransientError(`gemini skipped ${missing.length} line(s)`);
    }
    return { out: lines.map((_, i) => map.get(startNo + i)!.replace(/\s*\n\s*/g, " ")), usedGoogle: false };
  } catch (e) {
    if (!(e instanceof BlockedError)) throw e;
    // Only this refused piece goes to Google Translate.
    return { out: await googleLines(lines), usedGoogle: true };
  }
}

export function splitParagraphs(text: string) {
  return text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function translateChapter(title: string, source: string) {
  const paras = splitParagraphs(source);
  const lines = [title || " ", ...paras];
  const results: string[] = [];
  let usedGoogle = false;
  let i = 0;
  while (i < lines.length) {
    let j = i;
    let len = 0;
    while (j < lines.length && (j === i || len + lines[j]!.length <= MAX_CHUNK_CHARS)) {
      len += lines[j]!.length;
      j++;
    }
    const r = await translateChunk(lines.slice(i, j), i);
    results.push(...r.out);
    usedGoogle ||= r.usedGoogle;
    i = j;
  }
  const [tTitle, ...body] = results;
  const text = body.join("\n\n");
  return {
    title: title ? (tTitle ?? "") : "",
    text,
    usedGoogle,
    words: text.split(/\s+/).filter(Boolean).length,
  };
}
