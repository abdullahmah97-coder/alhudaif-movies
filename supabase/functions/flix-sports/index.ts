// flix-sports: fixtures and live scores by league for Hudaif Flix (حضيف فليكس).
// Reads ESPN's public scoreboards (no key; unofficial, so they can change without notice),
// keeps only what the app shows, puts league and well-known team names in Arabic, and adds the
// official broadcaster in Saudi Arabia for each competition. Rights change between seasons:
// update BROADCASTERS / LEAGUES here and the app follows without a new TV install.
//
//   GET .../functions/v1/flix-sports/matches?date=YYYY-MM-DD   a day in Riyadh time (default: today)
//   GET .../functions/v1/flix-sports/days?from=YYYY-MM-DD&count=7   how many matches each day has
//
// Deployed with verify_jwt = false on purpose: public, read-only data for app users with no account.

const ESPN = "https://site.api.espn.com/apis/site/v2/sports/";
const RIYADH_OFFSET_MS = 3 * 3600_000;
// ESPN refuses Deno's default user agent, so ask like a browser does.
const HEADERS = { "User-Agent": "Mozilla/5.0 (compatible; HudaifFlix/1.0)", Accept: "application/json" };

/** Official broadcaster in Saudi Arabia, season 2026-27. */
const BROADCASTERS = {
  thmanyah: { name: "ثمانية", web: "https://thmanyah.com", app: "thmanyah" },
  bein: { name: "beIN SPORTS · TOD", web: "https://www.tod.tv", app: "tod" },
  starzplay: { name: "STARZPLAY", web: "https://www.starzplay.com", app: "starzplay" },
  shahid: { name: "شاهد · MBC Action", web: "https://shahid.mbc.net", app: "shahid" },
} as const;
type Tv = keyof typeof BROADCASTERS;

type Sport = "soccer" | "basketball";
type League = { slug: string; sport: Sport; name: string; short: string; tv: Tv; note?: string };

/** Competitions in the order the app lists them. */
const LEAGUES: League[] = [
  { slug: "ksa.1", sport: "soccer", name: "دوري روشن السعودي", short: "روشن", tv: "thmanyah" },
  { slug: "ksa.kings.cup", sport: "soccer", name: "كأس خادم الحرمين الشريفين", short: "كأس الملك", tv: "thmanyah" },
  { slug: "afc.champions", sport: "soccer", name: "دوري أبطال آسيا للنخبة", short: "أبطال آسيا", tv: "bein" },
  { slug: "uefa.champions", sport: "soccer", name: "دوري أبطال أوروبا", short: "أبطال أوروبا", tv: "bein" },
  { slug: "eng.1", sport: "soccer", name: "الدوري الإنجليزي الممتاز", short: "الإنجليزي", tv: "bein" },
  { slug: "esp.1", sport: "soccer", name: "الدوري الإسباني", short: "الإسباني", tv: "bein" },
  { slug: "ita.1", sport: "soccer", name: "الدوري الإيطالي", short: "الإيطالي", tv: "starzplay" },
  { slug: "ger.1", sport: "soccer", name: "الدوري الألماني", short: "الألماني", tv: "shahid" },
  { slug: "fra.1", sport: "soccer", name: "الدوري الفرنسي", short: "الفرنسي", tv: "bein" },
  { slug: "uefa.europa", sport: "soccer", name: "الدوري الأوروبي", short: "الأوروبي", tv: "bein" },
  { slug: "uefa.europa.conf", sport: "soccer", name: "دوري المؤتمر الأوروبي", short: "المؤتمر", tv: "bein" },
  {
    slug: "nba", sport: "basketball", name: "دوري كرة السلة الأمريكي NBA", short: "NBA", tv: "bein",
    note: "beIN SPORTS تنقل مباريات مختارة كل أسبوع، والباقي على NBA League Pass.",
  },
];

/** Arabic names for well-known clubs, keyed by the ESPN name in lower case letters and digits only. */
const AR: Record<string, string> = {
  // Saudi Arabia
  alhilal: "الهلال", alnassr: "النصر", alittihad: "الاتحاد", alittihadjeddah: "الاتحاد", alahli: "الأهلي", alahlisaudi: "الأهلي",
  alahlijeddah: "الأهلي", alqadsiah: "القادسية", alqadisiyah: "القادسية", alshabab: "الشباب", alettifaq: "الاتفاق", altaawoun: "التعاون",
  altaawon: "التعاون", alfateh: "الفتح", alkhaleej: "الخليج", alkholood: "الخلود", alfayha: "الفيحاء", alfeiha: "الفيحاء", neom: "نيوم",
  neomsc: "نيوم", alhazem: "الحزم", abha: "أبها", aldiriyah: "الدرعية", aldiriya: "الدرعية", alfaisaly: "الفيصلي", alriyadh: "الرياض",
  damac: "ضمك", alokhdood: "الأخدود", alakhdoud: "الأخدود", alraed: "الرائد", alwehda: "الوحدة", alorobah: "العروبة", alnajma: "النجمة",
  albatin: "الباطن", altai: "الطائي", aladalah: "العدالة", aljabalain: "الجبلين", aljandal: "الجندل", alzulfi: "الزلفي", alarabi: "العربي",
  ohod: "أحد", jeddah: "جدة", alain: "العين",
  // Gulf and Asia
  alwahda: "الوحدة", shababalahli: "شباب الأهلي", alwasl: "الوصل", sharjah: "الشارقة", alsharjah: "الشارقة", alsadd: "السد",
  alduhail: "الدحيل", algharafa: "الغرافة", alrayyan: "الريان", persepolis: "برسبوليس", esteghlal: "استقلال", tractor: "تراكتور",
  sepahan: "سباهان", alshorta: "الشرطة", alzawraa: "الزوراء", pakhtakor: "باختاكور", nasaf: "ناساف",
  // England
  manchestercity: "مانشستر سيتي", manchesterunited: "مانشستر يونايتد", liverpool: "ليفربول", arsenal: "أرسنال", chelsea: "تشيلسي",
  tottenhamhotspur: "توتنهام", newcastleunited: "نيوكاسل", astonvilla: "أستون فيلا", westhamunited: "وست هام", everton: "إيفرتون",
  brightonandhovealbion: "برايتون", nottinghamforest: "نوتنغهام فورست", crystalpalace: "كريستال بالاس", fulham: "فولهام",
  brentford: "برينتفورد", wolverhamptonwanderers: "وولفرهامبتون", bournemouth: "بورنموث", afcbournemouth: "بورنموث",
  leedsunited: "ليدز يونايتد", sunderland: "سندرلاند", burnley: "بيرنلي", coventrycity: "كوفنتري", hullcity: "هال سيتي",
  // Spain
  realmadrid: "ريال مدريد", barcelona: "برشلونة", atleticomadrid: "أتلتيكو مدريد", sevilla: "إشبيلية", valencia: "فالنسيا",
  villarreal: "فياريال", realsociedad: "ريال سوسيداد", athleticclub: "أتلتيك بلباو", realbetis: "ريال بيتيس", girona: "جيرونا",
  // Italy
  internazionale: "إنتر ميلان", intermilan: "إنتر ميلان", acmilan: "ميلان", juventus: "يوفنتوس", napoli: "نابولي", asroma: "روما",
  roma: "روما", lazio: "لاتسيو", atalanta: "أتالانتا", fiorentina: "فيورنتينا", bologna: "بولونيا",
  // Germany
  bayernmunich: "بايرن ميونخ", borussiadortmund: "بوروسيا دورتموند", bayerleverkusen: "باير ليفركوزن", rbleipzig: "لايبزيغ",
  eintrachtfrankfurt: "آينتراخت فرانكفورت", vfbstuttgart: "شتوتغارت", borussiamonchengladbach: "مونشنغلادباخ",
  // France
  parissaintgermain: "باريس سان جيرمان", marseille: "مارسيليا", olympiquedemarseille: "مارسيليا", lyon: "ليون",
  olympiquelyonnais: "ليون", asmonaco: "موناكو", monaco: "موناكو", lille: "ليل",
  // Elsewhere in Europe
  benfica: "بنفيكا", fcporto: "بورتو", porto: "بورتو", sportingcp: "سبورتنغ لشبونة", ajax: "أياكس", afcajax: "أياكس",
  psveindhoven: "آيندهوفن", psv: "آيندهوفن", feyenoord: "فينورد", galatasaray: "غلطة سراي", fenerbahce: "فنربخشة", celtic: "سلتيك",
  clubbrugge: "كلوب بروج",
  // NBA
  atlantahawks: "أتلانتا هوكس", bostonceltics: "بوسطن سلتيكس", brooklynnets: "بروكلين نتس", charlottehornets: "شارلوت هورنتس",
  chicagobulls: "شيكاغو بولز", clevelandcavaliers: "كليفلاند كافالييرز", dallasmavericks: "دالاس مافريكس", denvernuggets: "دنفر ناغتس",
  detroitpistons: "ديترويت بيستونز", goldenstatewarriors: "غولدن ستيت ووريرز", houstonrockets: "هيوستن روكتس", indianapacers: "إنديانا بيسرز",
  laclippers: "لوس أنجلوس كليبرز", losangelesclippers: "لوس أنجلوس كليبرز", losangeleslakers: "لوس أنجلوس ليكرز",
  memphisgrizzlies: "ممفيس غريزليز", miamiheat: "ميامي هيت", milwaukeebucks: "ميلووكي باكس", minnesotatimberwolves: "مينيسوتا تمبروولفز",
  neworleanspelicans: "نيو أورلينز بيليكانز", newyorkknicks: "نيويورك نيكس", oklahomacitythunder: "أوكلاهوما سيتي ثاندر",
  orlandomagic: "أورلاندو ماجيك", philadelphia76ers: "فيلادلفيا سفنتي سيكسرز", phoenixsuns: "فينيكس صنز",
  portlandtrailblazers: "بورتلاند تريل بليزرز", sacramentokings: "ساكرامنتو كينغز", sanantoniospurs: "سان أنطونيو سبيرز",
  torontoraptors: "تورونتو رابتورز", utahjazz: "يوتا جاز", washingtonwizards: "واشنطن ويزاردز",
  // More of the top five leagues
  ipswichtown: "إبسويتش", leicestercity: "ليستر سيتي", southampton: "ساوثهامبتون", sheffieldunited: "شيفيلد يونايتد",
  middlesbrough: "ميدلزبره", norwichcity: "نوريتش", wolves: "وولفرهامبتون",
  espanyol: "إسبانيول", getafe: "خيتافي", osasuna: "أوساسونا", celtavigo: "سيلتا فيغو", mallorca: "مايوركا",
  rayovallecano: "رايو فاليكانو", alaves: "ألافيس", deportivoalaves: "ألافيس", laspalmas: "لاس بالماس", leganes: "ليغانيس",
  realvalladolid: "بلد الوليد", elche: "إلتشي", levante: "ليفانتي", realoviedo: "ريال أوفييدو", oviedo: "ريال أوفييدو",
  racingsantander: "راسينغ سانتاندير", deportivolacoruna: "ديبورتيفو لاكورونيا", almeria: "ألميريا", cadiz: "قادش", granada: "غرناطة",
  venezia: "فينيسيا", udinese: "أودينيزي", torino: "تورينو", genoa: "جنوى", sassuolo: "ساسولو", cagliari: "كالياري", lecce: "ليتشي",
  verona: "فيرونا", hellasverona: "فيرونا", parma: "بارما", como: "كومو", empoli: "إمبولي", monza: "مونزا", pisa: "بيزا",
  cremonese: "كريمونيزي", palermo: "باليرمو", sampdoria: "سامبدوريا",
  fccologne: "كولن", "1fckoln": "كولن", unionberlin: "يونيون برلين", scfreiburg: "فرايبورغ", mainz: "ماينز", fsvmainz05: "ماينز",
  vflwolfsburg: "فولفسبورغ", werderbremen: "فيردر بريمن", fcaugsburg: "أوغسبورغ", augsburg: "أوغسبورغ", tsghoffenheim: "هوفنهايم",
  hoffenheim: "هوفنهايم", "1fcheidenheim1846": "هايدنهايم", heidenheim: "هايدنهايم", stpauli: "سانت باولي", fcstpauli: "سانت باولي",
  hamburgsv: "هامبورغ", holsteinkiel: "هولشتاين كيل", vflbochum: "بوخوم", schalke04: "شالكه", herthaberlin: "هيرتا برلين",
  nice: "نيس", ogcnice: "نيس", lens: "لانس", rclens: "لانس", staderennais: "رين", rennes: "رين", strasbourg: "ستراسبورغ",
  nantes: "نانت", toulouse: "تولوز", stadebrestois29: "بريست", brest: "بريست", reims: "ريمس", montpellier: "مونبلييه",
  angers: "أنجيه", lehavreac: "لوهافر", lehavre: "لوهافر", ajauxerre: "أوكسير", auxerre: "أوكسير", saintetienne: "سانت إيتيان",
  lorient: "لوريان", metz: "ميتز", parisfc: "باريس إف سي",
};
const keyOf = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/&/g, "and").replace(/[^a-z0-9]/g, "");

// deno-lint-ignore no-explicit-any
type Json = any;

function statusOf(c: Json, sport: Sport): { state: string; label: string } {
  const t = c?.status?.type ?? {};
  const name = String(t.name ?? "");
  const short = String(t.shortDetail ?? "");
  if (name === "STATUS_POSTPONED") return { state: "off", label: "تأجلت" };
  if (name === "STATUS_CANCELED" || name === "STATUS_ABANDONED") return { state: "off", label: "ألغيت" };
  if (sport === "basketball" && t.state === "in" && name !== "STATUS_HALFTIME") {
    const p = Number(c?.status?.period ?? 0), clock = String(c?.status?.displayClock ?? "");
    const part = p > 4 ? "وقت إضافي" + (p > 5 ? " " + (p - 4) : "") : "الربع " + (p || 1);
    if (name === "STATUS_END_PERIOD") return { state: "in", label: "نهاية " + part };
    return { state: "in", label: clock && clock !== "0.0" ? part + " · " + clock : part };
  }
  if (sport === "basketball" && t.state === "post") return { state: "post", label: /OT/i.test(short) ? "انتهت بعد الوقت الإضافي" : "انتهت" };
  if (t.state === "in") {
    if (name === "STATUS_HALFTIME") return { state: "in", label: "استراحة" };
    if (name === "STATUS_SHOOTOUT") return { state: "in", label: "ركلات ترجيح" };
    return { state: "in", label: String(c?.status?.displayClock || "مباشر") };
  }
  if (t.state === "post") {
    if (/pen|pk/i.test(short)) return { state: "post", label: "انتهت بالترجيح" };
    if (/aet|extra/i.test(short)) return { state: "post", label: "انتهت بعد الأشواط الإضافية" };
    return { state: "post", label: "انتهت" };
  }
  return { state: "pre", label: "" };
}

function side(x: Json, sport: Sport) {
  const team = x?.team ?? {};
  const en = String(team.displayName ?? team.shortDisplayName ?? "");
  const record = sport === "basketball" ? x?.records?.find?.((r: Json) => r?.type === "total")?.summary ?? x?.records?.[0]?.summary : null;
  return {
    name: AR[keyOf(en)] ?? AR[keyOf(String(team.shortDisplayName ?? ""))] ?? en,
    logo: typeof team.logo === "string" ? team.logo : "",
    score: x?.score ?? "",
    pens: x?.shootoutScore ?? null,
    winner: x?.winner === true,
    record: typeof record === "string" ? record : null,
  };
}

const ymd = (d: Date) => d.toISOString().slice(0, 10).replaceAll("-", "");
const riyadhDay = (iso: string) => new Date(Date.parse(iso) + RIYADH_OFFSET_MS).toISOString().slice(0, 10);

/** One ESPN scoreboard day, shared by the Riyadh days that overlap it. Recent days refresh often. */
const espnCache = new Map<string, { at: number; ttl: number; events: Json[] }>();
const inflight = new Map<string, Promise<Json[]>>();
function espn(l: League, day: string): Promise<Json[]> {
  const key = `${l.slug}/${day}`, hit = espnCache.get(key);
  if (hit && Date.now() - hit.at < hit.ttl) return Promise.resolve(hit.events);
  if (!inflight.has(key)) inflight.set(key, fetchDay(l, day, key).finally(() => inflight.delete(key)));
  return inflight.get(key)!;
}
async function fetchDay(l: League, day: string, key: string): Promise<Json[]> {
  let events: Json[] = [], ok = false;
  try {
    const r = await fetch(`${ESPN}${l.sport}/${l.slug}/scoreboard?dates=${day}`, { headers: HEADERS, signal: AbortSignal.timeout(8000) });
    if (r.ok) {
      const j = await r.json();
      ok = true;
      events = Array.isArray(j?.events) ? j.events.map((e: Json) => ({ ...e, _leagueLogo: j?.leagues?.[0]?.logos?.[0]?.href ?? "" })) : [];
    }
  } catch {
    // treated as no matches, retried soon
  }
  const near = Math.abs(Date.parse(day.replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3")) - Date.now()) < 2 * 86400_000;
  if (espnCache.size > 400) espnCache.clear();
  espnCache.set(key, { at: Date.now(), ttl: !ok ? 20_000 : near ? 30_000 : 600_000, events });
  return events;
}

async function matchesFor(date: string) {
  // ESPN's day is US Eastern; a Riyadh day spans that day and the one before it.
  const d = new Date(date + "T12:00:00Z");
  const days = [ymd(new Date(d.getTime() - 86400_000)), ymd(d)];
  const leagues = await Promise.all(LEAGUES.map(async (l) => {
    const events = (await Promise.all(days.map((day) => espn(l, day)))).flat();
    const seen = new Set<string>();
    let logo = "";
    const matches = events
      .filter((e) => typeof e?.date === "string" && riyadhDay(e.date) === date && !seen.has(e.id) && seen.add(e.id))
      .map((e) => {
        logo ||= e._leagueLogo;
        const c = e.competitions?.[0] ?? {};
        const teams = Array.isArray(c.competitors) ? c.competitors : [];
        const home = teams.find((t: Json) => t.homeAway === "home") ?? teams[0];
        const away = teams.find((t: Json) => t.homeAway === "away") ?? teams[1];
        return { id: String(e.id), start: e.date, ...statusOf(c, l.sport), home: side(home, l.sport), away: side(away, l.sport) };
      })
      .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
    return { slug: l.slug, sport: l.sport, name: l.name, short: l.short, tv: l.tv, note: l.note ?? null, logo, matches };
  }));
  const shown = leagues.filter((l) => l.matches.length);
  const live = shown.some((l) => l.matches.some((m) => m.state === "in"));
  return { date, updated: new Date().toISOString(), live, broadcasters: BROADCASTERS, leagues: shown };
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "accept, content-type",
  "Access-Control-Max-Age": "86400",
};
const reply = (status: number, body: unknown, maxAge = 0) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": maxAge ? `public, max-age=${maxAge}` : "no-store" },
  });

const cache = new Map<string, { at: number; ttl: number; body: string; data: Json }>();

async function day(date: string, today: string) {
  const hit = cache.get(date);
  if (hit && Date.now() - hit.at < hit.ttl * 1000) return hit;
  const data = await matchesFor(date);
  // An empty day may just be ESPN failing for a moment, so browsers keep it only briefly.
  const ttl = data.live || !data.leagues.length ? (data.live ? 30 : 60) : date === today ? 60 : date < today ? 1800 : 900;
  if (cache.size > 60) cache.clear();
  const entry = { at: Date.now(), ttl, body: JSON.stringify(data), data };
  cache.set(date, entry);
  return entry;
}
const addDays = (date: string, n: number) => new Date(Date.parse(date + "T12:00:00Z") + n * 86400_000).toISOString().slice(0, 10);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "GET") return reply(405, { error: "method_not_allowed" });
  const url = new URL(req.url);
  const path = url.pathname.match(/\/flix-sports(\/[^?]*)?$/)?.[1] ?? "/";
  if (path === "/" || path === "/health") return reply(200, { ok: true });

  const today = riyadhDay(new Date().toISOString());
  const valid = (d: string | null) => /^\d{4}-\d{2}-\d{2}$/.test(d ?? "") && Math.abs(Date.parse(d!) - Date.parse(today)) / 86400_000 <= 30;

  if (path === "/matches") {
    const date = url.searchParams.get("date") ?? today;
    if (!valid(date)) return reply(400, { error: "date_out_of_range" });
    const entry = await day(date, today);
    return reply(200, entry.body, entry.ttl);
  }

  if (path === "/days") {
    const from = url.searchParams.get("from") ?? today;
    const count = Math.min(10, Math.max(1, Number(url.searchParams.get("count")) || 7));
    if (!valid(from)) return reply(400, { error: "date_out_of_range" });
    const dates = Array.from({ length: count }, (_, i) => addDays(from, i)).filter((d) => valid(d));
    const out: Json[] = [];
    for (let i = 0; i < dates.length; i += 3) { // a few days at a time, to go easy on ESPN
      const chunk = await Promise.all(dates.slice(i, i + 3).map((d) => day(d, today)));
      chunk.forEach((e) => out.push({
        date: e.data.date,
        count: e.data.leagues.reduce((n: number, l: Json) => n + l.matches.length, 0),
        live: e.data.live,
      }));
    }
    return reply(200, { days: out }, 60);
  }

  return reply(404, { error: "not_found" });
});
