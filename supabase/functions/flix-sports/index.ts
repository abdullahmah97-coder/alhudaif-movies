// flix-sports: fixtures and live scores by league for Hudaif Flix (حضيف فليكس).
// Reads ESPN's public soccer scoreboard (no key; unofficial, so it can change without notice),
// keeps only what the app shows, puts league and well-known team names in Arabic, and adds the
// official broadcaster in Saudi Arabia for each competition. Rights change between seasons:
// update BROADCASTERS / LEAGUES here and the app follows without a new TV install.
//
//   GET .../functions/v1/flix-sports/matches?date=YYYY-MM-DD   a day in Riyadh time (default: today)
//
// Deployed with verify_jwt = false on purpose: public, read-only data for app users with no account.

const ESPN = "https://site.api.espn.com/apis/site/v2/sports/soccer/";
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

/** Competitions in the order the app lists them. */
const LEAGUES: { slug: string; name: string; tv: Tv }[] = [
  { slug: "ksa.1", name: "دوري روشن السعودي", tv: "thmanyah" },
  { slug: "ksa.kings.cup", name: "كأس خادم الحرمين الشريفين", tv: "thmanyah" },
  { slug: "afc.champions", name: "دوري أبطال آسيا للنخبة", tv: "bein" },
  { slug: "uefa.champions", name: "دوري أبطال أوروبا", tv: "bein" },
  { slug: "eng.1", name: "الدوري الإنجليزي الممتاز", tv: "bein" },
  { slug: "esp.1", name: "الدوري الإسباني", tv: "bein" },
  { slug: "ita.1", name: "الدوري الإيطالي", tv: "starzplay" },
  { slug: "ger.1", name: "الدوري الألماني", tv: "shahid" },
  { slug: "fra.1", name: "الدوري الفرنسي", tv: "bein" },
  { slug: "uefa.europa", name: "الدوري الأوروبي", tv: "bein" },
  { slug: "uefa.europa.conf", name: "دوري المؤتمر الأوروبي", tv: "bein" },
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

function statusOf(c: Json): { state: string; label: string } {
  const t = c?.status?.type ?? {};
  const name = String(t.name ?? "");
  const short = String(t.shortDetail ?? "");
  if (name === "STATUS_POSTPONED") return { state: "off", label: "تأجلت" };
  if (name === "STATUS_CANCELED" || name === "STATUS_ABANDONED") return { state: "off", label: "ألغيت" };
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

function side(x: Json) {
  const team = x?.team ?? {};
  const en = String(team.displayName ?? team.shortDisplayName ?? "");
  return {
    name: AR[keyOf(en)] ?? AR[keyOf(String(team.shortDisplayName ?? ""))] ?? en,
    logo: typeof team.logo === "string" ? team.logo : "",
    score: x?.score ?? "",
    pens: x?.shootoutScore ?? null,
    winner: x?.winner === true,
  };
}

const ymd = (d: Date) => d.toISOString().slice(0, 10).replaceAll("-", "");
const riyadhDay = (iso: string) => new Date(Date.parse(iso) + RIYADH_OFFSET_MS).toISOString().slice(0, 10);

async function espn(slug: string, day: string): Promise<Json[]> {
  try {
    const r = await fetch(`${ESPN}${slug}/scoreboard?dates=${day}`, { headers: HEADERS, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return [];
    const j = await r.json();
    return Array.isArray(j?.events) ? j.events.map((e: Json) => ({ ...e, _leagueLogo: j?.leagues?.[0]?.logos?.[0]?.href ?? "" })) : [];
  } catch {
    return [];
  }
}

async function matchesFor(date: string) {
  // ESPN's day is US Eastern; a Riyadh day spans that day and the one before it.
  const d = new Date(date + "T12:00:00Z");
  const days = [ymd(new Date(d.getTime() - 86400_000)), ymd(d)];
  const leagues = await Promise.all(LEAGUES.map(async (l) => {
    const events = (await Promise.all(days.map((day) => espn(l.slug, day)))).flat();
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
        return { id: String(e.id), start: e.date, ...statusOf(c), home: side(home), away: side(away) };
      })
      .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
    return { slug: l.slug, name: l.name, tv: l.tv, logo, matches };
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

const cache = new Map<string, { at: number; ttl: number; body: string }>();

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "GET") return reply(405, { error: "method_not_allowed" });
  const url = new URL(req.url);
  const path = url.pathname.match(/\/flix-sports(\/[^?]*)?$/)?.[1] ?? "/";
  if (path === "/" || path === "/health") return reply(200, { ok: true });
  if (path !== "/matches") return reply(404, { error: "not_found" });

  const today = riyadhDay(new Date().toISOString());
  const date = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get("date") ?? "") ? url.searchParams.get("date")! : today;
  const gap = Math.abs(Date.parse(date) - Date.parse(today)) / 86400_000;
  if (!(gap <= 30)) return reply(400, { error: "date_out_of_range" });

  const hit = cache.get(date);
  if (hit && Date.now() - hit.at < hit.ttl * 1000) return reply(200, hit.body, hit.ttl);

  const data = await matchesFor(date);
  const ttl = data.live ? 30 : date === today ? 60 : date < today ? 1800 : 900;
  const body = JSON.stringify(data);
  if (cache.size > 60) cache.clear();
  cache.set(date, { at: Date.now(), ttl, body });
  return reply(200, body, ttl);
});
