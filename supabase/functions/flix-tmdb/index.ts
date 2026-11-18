// flix-tmdb: the shared server for Hudaif Flix (حضيف فليكس).
// A public, read-only proxy to TMDB so nobody using the app (TV, phone or browser) needs a TMDB key.
//
// Where the key comes from, in order:
//   1. the Edge Function secret TMDB_API_KEY (v3 API key or v4 read access token), if set;
//   2. otherwise the key saved once through POST /setup, kept in the private Storage bucket "flix-tmdb".
// /setup only works while no key is configured, and only keeps a key that TMDB accepts. To replace the
// key later, set TMDB_API_KEY or delete flix-tmdb/config.json in Storage.
//
//   GET  .../functions/v1/flix-tmdb/health          -> {"ok": true} once a key is configured
//   GET  .../functions/v1/flix-tmdb/3/<tmdb path>?… -> the TMDB response (only the paths the app uses)
//   POST .../functions/v1/flix-tmdb/setup  {"key"}   -> {"ok": true} | 409 already_configured | 400 bad_key
//
// Deployed with verify_jwt = false on purpose: app users have no account or key, and plain GET
// requests without an Authorization header avoid a CORS preflight on every call (slow on TVs).

import { createClient } from "npm:@supabase/supabase-js@2";

const TMDB = "https://api.themoviedb.org/3";
const BUCKET = "flix-tmdb";
const OBJECT = "config.json";

/** The TMDB paths the app uses. Everything else is refused. */
const ALLOW = [
  /^\/configuration$/,
  /^\/trending\/(all|movie|tv)\/(day|week)$/,
  /^\/discover\/(movie|tv)$/,
  /^\/search\/(multi|movie|tv)$/,
  /^\/genre\/(movie|tv)\/list$/,
  /^\/watch\/providers\/(movie|tv|regions)$/,
  /^\/(movie|tv)\/\d{1,9}$/,
  /^\/(movie|tv)\/\d{1,9}\/(watch\/providers|videos|recommendations|similar|credits|images|external_ids)$/,
];
const KEY_FORMAT = /^([0-9a-f]{32}|eyJ[\w-]+\.[\w-]+\.[\w-]+)$/i;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "accept, content-type",
  "Access-Control-Max-Age": "86400",
};

const reply = (status: number, body: unknown, extra: Record<string, string> = {}) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8", ...extra },
  });

/** Seconds a response may be reused: catalogues change slowly, search results a little faster. */
function ttl(path: string): number {
  if (path.startsWith("/search/")) return 900;
  if (path === "/configuration" || path.startsWith("/genre/") || path.startsWith("/watch/providers/")) return 86400;
  if (path.endsWith("/watch/providers")) return 21600;
  return 3600;
}

const TIMEOUT_MS = 10_000;
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

// ---------- the key ----------
let storedKey = "";
let storedCheckedAt = 0;
const RECHECK_MS = 30_000; // other instances pick up a key saved through /setup within 30 s

async function loadStoredKey(force = false): Promise<string> {
  if (storedKey) return storedKey;
  if (!force && Date.now() - storedCheckedAt < RECHECK_MS) return "";
  storedCheckedAt = Date.now();
  try {
    const { data, error } = await db.storage.from(BUCKET).download(OBJECT);
    if (!error && data) {
      const cfg = JSON.parse(await data.text());
      if (typeof cfg?.key === "string") storedKey = cfg.key.trim();
    }
  } catch {
    // not saved yet
  }
  return storedKey;
}

async function currentKey(force = false): Promise<string> {
  return (Deno.env.get("TMDB_API_KEY") ?? "").trim() || (await loadStoredKey(force));
}

function withKey(url: URL, key: string): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (key.startsWith("eyJ")) headers.Authorization = `Bearer ${key}`;
  else url.searchParams.set("api_key", key);
  return headers;
}

// ---------- POST /setup: the first key entered in the app becomes the shared key ----------
async function setup(req: Request): Promise<Response> {
  if (await currentKey(true)) return reply(409, { error: "already_configured" });
  let key = "";
  try {
    key = String(JSON.parse(await req.text())?.key ?? "").trim();
  } catch {
    // unreadable body
  }
  if (!KEY_FORMAT.test(key)) return reply(400, { error: "bad_key" });

  const test = new URL(TMDB + "/configuration");
  let accepted = false;
  try {
    accepted = (await fetch(test, { headers: withKey(test, key), signal: AbortSignal.timeout(TIMEOUT_MS) })).ok;
  } catch {
    return reply(502, { error: "tmdb_unreachable" });
  }
  if (!accepted) return reply(400, { error: "bad_key" });

  await db.storage.createBucket(BUCKET, { public: false }); // an existing bucket is fine
  const { error } = await db.storage.from(BUCKET).upload(
    OBJECT,
    JSON.stringify({ key, set_at: new Date().toISOString() }),
    { contentType: "application/json", upsert: false },
  );
  if (error) {
    if (await loadStoredKey(true)) return reply(409, { error: "already_configured" });
    console.error("setup_store_failed", error.message);
    return reply(500, { error: "store_failed" });
  }
  storedKey = key;
  storedCheckedAt = Date.now();
  console.log("tmdb_key_configured");
  return reply(200, { ok: true });
}

// ---------- GET proxy ----------
const cache = new Map<string, { at: number; body: string }>();
const MAX_ENTRIES = 500;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const url = new URL(req.url);
  const path = url.pathname.match(/\/flix-tmdb(?:\/3)?(\/[^?]*)?$/)?.[1] ?? "/";

  if (req.method === "POST" && path === "/setup") return setup(req);
  if (req.method !== "GET") return reply(405, { error: "method_not_allowed" });

  const key = await currentKey();
  if (path === "/" || path === "/health") return reply(200, { ok: key.length > 0 }, { "Cache-Control": "no-store" });
  if (!ALLOW.some((r) => r.test(path))) return reply(404, { error: "not_allowed" });
  if (!key) return reply(503, { error: "not_configured" });

  const params = new URLSearchParams();
  for (const [k, v] of url.searchParams) if (k !== "api_key" && v.length <= 200) params.set(k, v);
  params.sort();
  const id = path + "?" + params.toString();
  const maxAge = ttl(path);

  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < maxAge * 1000) {
    return reply(200, hit.body, { "Cache-Control": `public, max-age=${maxAge}`, "X-Cache": "hit" });
  }

  const upstream = new URL(TMDB + path);
  params.forEach((v, k) => upstream.searchParams.set(k, v));
  let res: Response;
  try {
    res = await fetch(upstream, { headers: withKey(upstream, key), signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    return reply(502, { error: "tmdb_unreachable" });
  }
  const body = await res.text();
  if (res.status === 401) {
    console.error("tmdb_key_rejected");
    return reply(503, { error: "bad_server_key" });
  }
  if (!res.ok) return reply(res.status, body, { "Cache-Control": "no-store" });

  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(id, { at: Date.now(), body });
  return reply(200, body, { "Cache-Control": `public, max-age=${maxAge}`, "X-Cache": "miss" });
});
