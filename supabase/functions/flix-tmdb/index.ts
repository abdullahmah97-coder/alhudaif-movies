// flix-tmdb: the shared server for Hudaif Flix (حضيف فليكس).
// A public, read-only proxy to TMDB so nobody using the app (TV, phone or browser) needs a TMDB key.
// The key lives only in the Edge Function secret TMDB_API_KEY (the v3 API key, or the v4 read access token).
// Only GET requests to the paths the app uses are forwarded; responses are cached in memory and by browsers.
//
//   GET .../functions/v1/flix-tmdb/health          -> {"ok": true}  once TMDB_API_KEY is set, otherwise {"ok": false}
//   GET .../functions/v1/flix-tmdb/3/<tmdb path>?… -> the TMDB response
//
// Deployed with verify_jwt = false on purpose: app users have no account or key, and plain GET
// requests without an Authorization header avoid a CORS preflight on every call (slow on TVs).

const TMDB = "https://api.themoviedb.org/3";

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

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
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

const cache = new Map<string, { at: number; body: string }>();
const MAX_ENTRIES = 500;
const TIMEOUT_MS = 10_000;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "GET") return reply(405, { error: "method_not_allowed" });

  const url = new URL(req.url);
  const path = url.pathname.match(/\/flix-tmdb(?:\/3)?(\/[^?]*)?$/)?.[1] ?? "/";
  const key = (Deno.env.get("TMDB_API_KEY") ?? "").trim();

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
  const headers: Record<string, string> = { Accept: "application/json" };
  if (key.startsWith("eyJ")) headers.Authorization = `Bearer ${key}`;
  else upstream.searchParams.set("api_key", key);

  let res: Response;
  try {
    res = await fetch(upstream, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
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
