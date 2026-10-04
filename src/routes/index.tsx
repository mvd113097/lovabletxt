import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useRef, useState } from "react";
import { Toaster, toast } from "sonner";
import {
  addChapters,
  authStatus,
  createNovel,
  getSettingsFn,
  listNovels,
  login,
  saveSettings,
  setNovelStatus,
  testTelegram,
} from "@/lib/novels.functions";
import { decodeNovel, splitChapters } from "@/lib/splitter";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "MegaTXT — Novel Translator" },
      { name: "description", content: "Upload a Chinese novel TXT and translate it to English in the background. Download the EPUB anytime." },
      { property: "og:title", content: "MegaTXT — Novel Translator" },
      { property: "og:description", content: "Background novel translation with Gemini and EPUB downloads." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: App,
});

type Novel = Awaited<ReturnType<typeof listNovels>>[number];
const TOKEN_KEY = "megatxt_token";

const btn =
  "inline-flex items-center justify-center rounded-lg px-4 py-2.5 text-sm font-medium transition-colors disabled:opacity-50";
const btnPrimary = `${btn} bg-primary text-primary-foreground hover:bg-primary/90`;
const btnGhost = `${btn} border border-border bg-secondary text-secondary-foreground hover:bg-accent`;
const input =
  "w-full rounded-lg border border-input bg-background px-3 py-2.5 text-base text-foreground outline-none focus:ring-2 focus:ring-ring";

function App() {
  const [token, setToken] = useState<string | null>(null);
  const [state, setState] = useState<"loading" | "setup" | "locked" | "ok">("loading");
  const status = useServerFn(authStatus);

  useEffect(() => {
    const t = localStorage.getItem(TOKEN_KEY);
    setToken(t);
    status({ data: { t } })
      .then((r) => setState(r.state))
      .catch(() => setState("locked"));
  }, [status]);

  const onToken = (t: string) => {
    localStorage.setItem(TOKEN_KEY, t);
    setToken(t);
    setState("ok");
  };

  return (
    <div className="mx-auto min-h-screen max-w-xl px-4 pb-16 pt-6">
      <Toaster theme="dark" position="top-center" />
      <header className="mb-6 flex items-center justify-between">
        <h1 className="font-serif text-2xl tracking-tight">
          Mega<span className="text-primary">TXT</span>
        </h1>
        {state === "ok" && token && <SettingsButton token={token} onToken={onToken} />}
      </header>
      {state === "loading" && <p className="text-muted-foreground">Loading…</p>}
      {(state === "setup" || state === "locked") && <Gate setup={state === "setup"} onToken={onToken} />}
      {state === "ok" && token && <Home token={token} onLocked={() => setState("locked")} />}
    </div>
  );
}

function Gate({ setup, onToken }: { setup: boolean; onToken: (t: string) => void }) {
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const doLogin = useServerFn(login);
  return (
    <form
      className="rounded-xl border border-border bg-card p-5"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          const r = await doLogin({ data: { pin } });
          onToken(r.token);
        } catch (err) {
          toast.error((err as Error).message.includes("Wrong") ? "Wrong passcode" : "Could not sign in");
        } finally {
          setBusy(false);
        }
      }}
    >
      <h2 className="font-serif text-lg">{setup ? "Create a passcode" : "Enter passcode"}</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {setup ? "At least 4 characters. You'll need it on every new device." : "This app is locked."}
      </p>
      <input
        className={`${input} mt-4`}
        type="password"
        inputMode="numeric"
        autoComplete={setup ? "new-password" : "current-password"}
        value={pin}
        onChange={(e) => setPin(e.target.value)}
        minLength={4}
        required
        autoFocus
      />
      <button className={`${btnPrimary} mt-4 w-full`} disabled={busy || pin.length < 4}>
        {busy ? "…" : setup ? "Save passcode" : "Unlock"}
      </button>
    </form>
  );
}

function Home({ token, onLocked }: { token: string; onLocked: () => void }) {
  const [novels, setNovels] = useState<Novel[] | null>(null);
  const list = useServerFn(listNovels);
  const busyRef = useRef(false);

  const refresh = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      setNovels(await list({ data: { t: token } }));
    } catch (e) {
      if ((e as Error).message.includes("UNAUTHORIZED")) onLocked();
    } finally {
      busyRef.current = false;
    }
  }, [list, token, onLocked]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Data-saving polling: only while something is running AND the screen is visible.
  const running = novels?.some((n) => n.status === "running");
  useEffect(() => {
    if (!running) return;
    const tick = () => document.visibilityState === "visible" && refresh();
    const id = setInterval(tick, 30_000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [running, refresh]);

  return (
    <div className="space-y-6">
      <Upload token={token} onDone={refresh} />
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-serif text-lg">Your novels</h2>
          <button className="text-sm text-muted-foreground underline-offset-4 hover:underline" onClick={refresh}>
            Refresh
          </button>
        </div>
        {novels === null && <p className="text-sm text-muted-foreground">Loading…</p>}
        {novels?.length === 0 && <p className="text-sm text-muted-foreground">No novels yet. Upload a TXT above.</p>}
        {novels?.map((n) => <NovelCard key={n.id} n={n} token={token} onChange={refresh} />)}
      </section>
    </div>
  );
}

function Upload({ token, onDone }: { token: string; onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [preview, setPreview] = useState<{ count: number; first: string; last: string } | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const create = useServerFn(createNovel);
  const add = useServerFn(addChapters);
  const setStatus = useServerFn(setNovelStatus);
  const fileRef = useRef<HTMLInputElement>(null);

  const pick = async (f: File | undefined) => {
    if (!f) return;
    setFile(f);
    setTitle(f.name.replace(/\.txt$/i, ""));
    const ch = splitChapters(decodeNovel(await f.arrayBuffer()));
    setPreview({ count: ch.length, first: ch[0]?.title || "(intro)", last: ch[ch.length - 1]?.title || "" });
  };

  const start = async () => {
    if (!file) return;
    try {
      const chapters = splitChapters(decodeNovel(await file.arrayBuffer()));
      if (!chapters.length) throw new Error("No text found in this file");
      setProgress(0);
      const { id } = await create({ data: { t: token, title: title.trim() || file.name, total: chapters.length } });
      // Upload in small batches; each retried so nothing is lost on a weak connection.
      let batch: typeof chapters = [];
      let size = 0;
      const send = async () => {
        for (let attempt = 0; ; attempt++) {
          try {
            await add({ data: { t: token, novelId: id, chapters: batch } });
            break;
          } catch (e) {
            if (attempt >= 4) throw e;
            await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
          }
        }
        setProgress(Math.round(((batch[batch.length - 1]!.idx + 1) / chapters.length) * 100));
        batch = [];
        size = 0;
      };
      for (const c of chapters) {
        if (batch.length >= 100 || size + c.text.length > 250_000) await send();
        batch.push(c);
        size += c.text.length;
      }
      if (batch.length) await send();
      await setStatus({ data: { t: token, novelId: id, action: "start" } });
      toast.success("Translation started. You can close this page.");
      setFile(null);
      setPreview(null);
      if (fileRef.current) fileRef.current.value = "";
      onDone();
    } catch (e) {
      toast.error((e as Error).message || "Upload failed");
    } finally {
      setProgress(null);
    }
  };

  return (
    <section className="rounded-xl border border-border bg-card p-5">
      <h2 className="font-serif text-lg">Translate a novel</h2>
      <p className="mt-1 text-sm text-muted-foreground">Upload a Chinese TXT file. It's split into chapters on your phone first, so only the text gets sent.</p>
      <label className={`${btnGhost} mt-4 w-full cursor-pointer`}>
        {file ? file.name : "Choose TXT file"}
        <input ref={fileRef} type="file" accept=".txt,text/plain" className="hidden" onChange={(e) => pick(e.target.files?.[0])} />
      </label>
      {preview && (
        <div className="mt-4 space-y-3">
          <input className={input} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Novel title" />
          <p className="text-sm text-muted-foreground">
            Found <span className="text-foreground">{preview.count}</span> chapters · {preview.first} → {preview.last}
          </p>
          <button className={`${btnPrimary} w-full`} onClick={start} disabled={progress !== null}>
            {progress !== null ? `Uploading ${progress}%` : "Start translating"}
          </button>
        </div>
      )}
    </section>
  );
}

function NovelCard({ n, token, onChange }: { n: Novel; token: string; onChange: () => void }) {
  const setStatus = useServerFn(setNovelStatus);
  const [busy, setBusy] = useState(false);
  const pct = n.total ? Math.floor((n.done / n.total) * 100) : 0;
  const incomplete = n.uploaded < n.total;
  const act = async (action: "start" | "pause" | "delete") => {
    if (action === "delete" && !confirm(`Delete "${n.title}" permanently?`)) return;
    setBusy(true);
    try {
      await setStatus({ data: { t: token, novelId: n.id, action } });
      onChange();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const dl = (format: "epub" | "txt") =>
    `/api/public/download?id=${n.id}&format=${format}&t=${encodeURIComponent(token)}`;
  const label =
    n.status === "done" ? "Finished" : n.status === "running" ? "Translating" : incomplete ? "Upload incomplete" : "Paused";

  return (
    <article className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <h3 className="font-serif text-base leading-snug">{n.title}</h3>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${
            n.status === "done" ? "bg-success/15 text-success" : n.status === "running" ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground"
          }`}
        >
          {label}
        </span>
      </div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted">
        <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        {n.done} / {n.total} chapters ({pct}%)
        {n.google > 0 && ` · ${n.google} sensitive chapter${n.google > 1 ? "s" : ""} via Google`}
      </p>
      {n.ready > 0 && (
        <p className="mt-1 text-xs text-muted-foreground">
          Ready to read: chapters 1–{n.ready} · {n.readyWords.toLocaleString()} words
        </p>
      )}
      {n.lastError && n.status === "running" && (
        <p className="mt-1 text-xs text-muted-foreground">Retrying a chapter… ({n.lastError.slice(0, 80)})</p>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        {n.ready > 0 && (
          <>
            <a className={btnPrimary} href={dl("epub")}>
              EPUB
            </a>
            <a className={btnGhost} href={dl("txt")}>
              TXT
            </a>
          </>
        )}
        {n.status === "running" && (
          <button className={btnGhost} disabled={busy} onClick={() => act("pause")}>
            Pause
          </button>
        )}
        {n.status === "paused" && !incomplete && (
          <button className={btnGhost} disabled={busy} onClick={() => act("start")}>
            Resume
          </button>
        )}
        <button className={`${btnGhost} ml-auto text-destructive`} disabled={busy} onClick={() => act("delete")}>
          Delete
        </button>
      </div>
    </article>
  );
}

function SettingsButton({ token, onToken }: { token: string; onToken: (t: string) => void }) {
  const [open, setOpen] = useState(false);
  const [chatId, setChatId] = useState("");
  const [connected, setConnected] = useState(false);
  const [pin, setPin] = useState("");
  const get = useServerFn(getSettingsFn);
  const save = useServerFn(saveSettings);
  const test = useServerFn(testTelegram);

  useEffect(() => {
    if (!open) return;
    get({ data: { t: token } }).then((s) => {
      setChatId(s.telegramChatId);
      setConnected(s.telegramConnected);
    });
  }, [open, get, token]);

  return (
    <>
      <button className="text-sm text-muted-foreground hover:text-foreground" onClick={() => setOpen((o) => !o)}>
        {open ? "Close" : "Settings"}
      </button>
      {open && (
        <div className="fixed inset-x-0 top-16 z-10 mx-auto max-w-xl px-4">
          <form
            className="space-y-3 rounded-xl border border-border bg-popover p-5 shadow-2xl"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                const r = await save({ data: { t: token, telegramChatId: chatId, newPin: pin || undefined } });
                onToken(r.token);
                setPin("");
                toast.success("Saved");
              } catch (err) {
                toast.error((err as Error).message);
              }
            }}
          >
            <h2 className="font-serif text-lg">Settings</h2>
            <label className="block text-sm">
              Telegram chat ID
              <input className={`${input} mt-1`} value={chatId} onChange={(e) => setChatId(e.target.value)} placeholder="e.g. 123456789" />
            </label>
            <p className="text-xs text-muted-foreground">
              {connected
                ? "Message your bot once, then put your chat ID here to get an alert when a novel finishes."
                : "Telegram isn't connected yet, so alerts are off."}
            </p>
            <label className="block text-sm">
              New passcode (optional)
              <input className={`${input} mt-1`} type="password" value={pin} onChange={(e) => setPin(e.target.value)} minLength={4} />
            </label>
            <div className="flex gap-2">
              <button className={btnPrimary}>Save</button>
              {connected && chatId && (
                <button
                  type="button"
                  className={btnGhost}
                  onClick={() => test({ data: { t: token } }).then(() => toast.success("Test sent"), (e) => toast.error(e.message))}
                >
                  Send test
                </button>
              )}
            </div>
          </form>
        </div>
      )}
    </>
  );
}
