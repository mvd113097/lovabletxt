import { supabaseAdmin } from "@/integrations/supabase/client.server";

const enc = new TextEncoder();

function b64url(buf: ArrayBuffer | Uint8Array) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmac(key: string, msg: string) {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", k, enc.encode(msg)));
}

export async function hashPasscode(pin: string, salt?: string) {
  const s = salt ?? b64url(crypto.getRandomValues(new Uint8Array(16)));
  const key = await crypto.subtle.importKey("raw", enc.encode(pin), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: enc.encode(s), iterations: 100_000, hash: "SHA-256" },
    key,
    256,
  );
  return `${s}:${b64url(bits)}`;
}

export async function getSettings() {
  const { data, error } = await supabaseAdmin.from("app_settings").select("*").eq("id", 1).single();
  if (error) throw new Error(error.message);
  return data;
}

function signingKey() {
  const k = process.env["SUPABASE_SERVICE_ROLE_KEY"];
  if (!k) throw new Error("Server not configured");
  return k;
}

export async function makeToken(passcodeHash: string) {
  return hmac(signingKey(), `megatxt:${passcodeHash}`);
}

/** Throws if token does not match the current passcode. */
export async function requireToken(token: string | undefined | null) {
  const s = await getSettings();
  if (!s.passcode_hash) throw new Error("NO_PASSCODE");
  if (!token || token !== (await makeToken(s.passcode_hash))) throw new Error("UNAUTHORIZED");
  return s;
}
