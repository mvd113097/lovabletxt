// Translation engine: Gemini first; Google Translate ONLY for parts Gemini refuses on safety grounds.
export const GEMINI_MODEL = "google/gemini-3.1-flash-lite";
// Bigger pieces = fewer requests against the free daily quota (original MegaTXT uses ~9000).
const MAX_CHUNK_CHARS = 9000;

export class BlockedError extends Error {}
export class TransientError extends Error {}
export class CreditsError extends Error {}

const SAFETY_RE = /safety|blocked|prohibited|content[_ ]?filter|recitation|harm_category|policy/i;

const SYSTEM = `You translate Chinese web novels into fluent, natural English.
Rules:
- Every input line starts with a marker like [[12]]. Output EVERY marker exactly once, in the same order, each on its own line followed by the English translation of that line.
- Never merge, skip, summarize or add lines. Never add notes or commentary.
- Keep names consistent and use pinyin for names.`;

// User's own free Gemini keys (GEMINI_API_KEYS, comma-separated, e.g. "AQ..." keys from different projects).
// Same strategy as the original MegaTXT: flash-lite first (largest free daily quota), other free models
// as backup, least-recently-used key rotation, and per key+model cooldowns that honour Google's retryDelay.
export const FREE_MODELS = ["gemini-3.1-flash-lite", "gemini-3.8-flash", "gemini-flash-latest"];
export const OWN_GEMINI_MODEL = FREE_MODELS[0]!;
const cooldown = new Map<string, number>(); // `${model}|${key}` or `${model}|*` -> ready-at ms
const lastUsed = new Map<string, number>();

// Free tier ≈ 15 requests/min per project; 6s gap keeps each key ≤ 10/min.
export const KEY_GAP_MS = 6000;

/** How many chapters to translate at once: one per own key (min 3). */
export function parallelChapters() {
  return Math.min(10, Math.max(3, ownKeys().length));
}

export function ownKeys() {
  const all = `${process.env["GEMINI_API_KEYS"] ?? process.env["GEMINI_API_KEY"] ?? ""},${process.env["GEMINI_API_KEY_EXTRA"] ?? ""}`;
  return all
    .split(/[,\s]+/)
    .map((k) => k.trim())
    .filter(Boolean);
}

/** ms until Google's free daily quota resets (midnight US Pacific ≈ 08:00 UTC). */
function msUntilDailyReset(now: number) {
  const d = new Date(now);
  const reset = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 8, 5);
  return (reset > now ? reset : reset + 86_400_000) - now;
}

export function retryDelayMs(body: string): number | null {
  const m = /"retryDelay"\s*:\s*"([\d.]+)s"/.exec(body);
  return m ? Math.ceil(Number(m[1]) * 1000) + 1000 : null;
}

async function ownGeminiCall(keys: string[], input: string): Promise<Map<number, string>> {
  let lastErr = "";
  for (const model of FREE_MODELS) {
    const now = Date.now();
    if ((cooldown.get(`${model}|*`) ?? 0) > now) continue;
    const ready = keys
      .filter((k) => (cooldown.get(`${model}|${k}`) ?? 0) <= now)
      .sort((a, b) => (lastUsed.get(a) ?? 0) - (lastUsed.get(b) ?? 0));
    for (const key of ready) {
      // Per-minute safety: never hit the same key more often than every KEY_GAP_MS.
      const wait = (lastUsed.get(key) ?? 0) + KEY_GAP_MS - Date.now();
      lastUsed.set(key, Date.now() + Math.max(0, wait));
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      let res: Response;
      try {
        res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": key },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: SYSTEM }] },
            contents: [{ role: "user", parts: [{ text: input }] }],
            generationConfig: { temperature: 0.3 },
            safetySettings: [
              "HARM_CATEGORY_HARASSMENT",
              "HARM_CATEGORY_HATE_SPEECH",
              "HARM_CATEGORY_SEXUALLY_EXPLICIT",
              "HARM_CATEGORY_DANGEROUS_CONTENT",
            ].map((category) => ({ category, threshold: "BLOCK_NONE" })),
          }),
        });
      } catch (e) {
        lastErr = `network: ${(e as Error).message}`;
        continue;
      }
      const body = await res.text();
      const t = Date.now();
      if (res.status === 429) {
        // Daily quota used up -> rest this key on this model until reset; per-minute -> wait what Google says.
        const daily = /PerDay|per day|daily/i.test(body);
        cooldown.set(`${model}|${key}`, t + (daily ? msUntilDailyReset(t) : (retryDelayMs(body) ?? 60_000)));
        lastErr = `${model} 429${daily ? " (daily)" : ""}`;
        continue;
      }
      if (res.status === 503 || res.status >= 500) {
        // Model overloaded for everyone: skip this model briefly, try the next free model.
        cooldown.set(`${model}|*`, t + 30_000);
        lastErr = `${model} ${res.status}`;
        break;
      }
      if (!res.ok) {
        if (SAFETY_RE.test(body)) throw new BlockedError(`gemini ${res.status}`);
        cooldown.set(`${model}|${key}`, t + 600_000); // bad key / not allowed on this model
        lastErr = `${model} ${res.status}: ${body.slice(0, 150)}`;
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
  }
  throw new TransientError(lastErr || "all Gemini keys resting (free limit)");
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
  if (res.ok) {
    const data = (await res.json()) as any;
    return (data?.[0] ?? []).map((x: any) => x?.[0] ?? "").join("");
  }
  // Backup free endpoint when the first one is rate-limited.
  const r2 = await fetch(
    "https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=auto&tl=en&q=" + encodeURIComponent(text),
  );
  if (!r2.ok) throw new TransientError(`google ${res.status}/${r2.status}`);
  const d2 = (await r2.json()) as any;
  const first = Array.isArray(d2) ? d2[0] : d2?.sentences?.map((s: any) => s.trans ?? "").join("");
  return Array.isArray(first) ? String(first[0] ?? "") : String(first ?? "");
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
    // Narrow down the refused part: split in half and retry Gemini, so only the
    // smallest refused piece (ideally one paragraph) ever goes to Google Translate.
    if (lines.length > 1) {
      const mid = Math.ceil(lines.length / 2);
      const a = await translateChunk(lines.slice(0, mid), startNo);
      const b = await translateChunk(lines.slice(mid), startNo + mid);
      return { out: [...a.out, ...b.out], usedGoogle: a.usedGoogle || b.usedGoogle };
    }
    return { out: await googleLines(lines), usedGoogle: true };
  }
}

function greedy(lens: number[], cap: number): [number, number][] {
  const out: [number, number][] = [];
  let i = 0;
  while (i < lens.length) {
    let j = i;
    let len = 0;
    while (j < lens.length && (j === i || len + lens[j]! <= cap)) len += lens[j++]!;
    out.push([i, j]);
    i = j;
  }
  return out;
}

/** Ordered [start,end) ranges: fewest requests possible, sizes as even as possible (no tiny tail piece). */
export function packChunks(lines: string[], max = MAX_CHUNK_CHARS): [number, number][] {
  const lens = lines.map((l) => l.length);
  const best = greedy(lens, max);
  if (best.length <= 1) return best;
  const total = lens.reduce((a, b) => a + b, 0);
  // Smallest cap that still needs no more requests than plain greedy packing.
  let lo = Math.ceil(total / best.length), hi = max;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (greedy(lens, mid).length <= best.length) hi = mid;
    else lo = mid + 1;
  }
  return greedy(lens, lo);
}

export function splitParagraphs(text: string) {
  return text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export type Partial = Record<string, { out: string[]; g?: boolean }>;

/** Translates a chapter piece by piece. Finished pieces are kept in `partial` (saved via onPiece)
 *  so a retry never re-sends work that already succeeded — protects the free daily quota. */
export async function translateChapter(
  title: string,
  source: string,
  partial: Partial = {},
  onPiece?: (p: Partial) => Promise<void>,
) {
  const paras = splitParagraphs(source);
  const lines = [title || " ", ...paras];
  const results: string[] = [];
  let usedGoogle = false;
  for (const [i, j] of packChunks(lines, MAX_CHUNK_CHARS)) {
    const k = `${i}-${j}`;
    let r = partial[k] && partial[k].out.length === j - i ? { out: partial[k].out, usedGoogle: !!partial[k].g } : null;
    if (!r) {
      r = await translateChunk(lines.slice(i, j), i);
      partial[k] = { out: r.out, g: r.usedGoogle };
      if (onPiece) await onPiece(partial);
    }
    results.push(...r.out);
    usedGoogle ||= r.usedGoogle;
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
