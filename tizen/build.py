#!/usr/bin/env python3
"""Builds the Samsung TV package (tizen/HudaifFlix.wgt, unsigned) from ../index.html.

2021 Samsung TVs (Tizen 6.0) run packaged web apps on Chromium 76, and Tizen blocks inline
<style>/<script> unless the app declares a content security policy. So this build:
  * moves the CSS and JS into files (config.xml also declares a CSP),
  * resolves clamp()/min()/max() at the TV's 1920x1080 viewport,
  * turns inset and logical properties into physical ones (the page is right-to-left),
  * replaces flex `gap` with margins (flex gap arrived in Chromium 84),
  * adds a small aspect-ratio fallback (aspect-ratio arrived in Chromium 88),
  * lowers the JavaScript syntax to Chromium 76 with esbuild,
  * bundles the fonts locally.
Sign the result with a Samsung certificate (Tizen Studio, or `tizen package -s <profile>`) before installing.

Usage: python3 build.py            (FONTSOURCE_DIR points at node_modules/@fontsource)
"""
import json, os, re, shutil, subprocess, zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(HERE, "build")
VW, VH, REM = 19.2, 10.8, 16.0          # 1920x1080 viewport, default root font size
FONTS = os.environ.get("FONTSOURCE_DIR", "/tmp/fonts2/node_modules/@fontsource")
WARN = []

def num(x):
    x = round(x, 2)
    return ("%d" % x) if x == int(x) else ("%.2f" % x).rstrip("0").rstrip(".")

def split_top(s, sep):
    out, depth, cur = [], 0, ""
    for ch in s:
        if ch == "(": depth += 1
        elif ch == ")": depth -= 1
        if ch == sep and depth == 0:
            out.append(cur); cur = ""
        else:
            cur += ch
    out.append(cur)
    return out

# ---------- math ----------
def to_px(expr):
    """Evaluate a calc-like expression of px/vw/vh/rem and plain numbers to px."""
    def unit(m):
        v, u = float(m.group(1)), (m.group(2) or "").lower()
        return repr({"px": v, "vw": v * VW, "vh": v * VH, "rem": v * REM, "": v}[u])
    py = re.sub(r"(-?\d*\.?\d+)(px|vw|vh|rem)?(?![\w%])", unit, expr)
    if not re.fullmatch(r"[\d\s.+\-*/()e]*", py):
        raise ValueError(expr)
    return float(eval(py, {"__builtins__": {}}))

def substitute(v, vars_):
    for _ in range(10):
        nv = re.sub(r"var\((--[\w-]+)(?:\s*,\s*([^()]*))?\)", lambda m: vars_.get(m.group(1), m.group(2) or m.group(0)), v)
        nv = re.sub(r"env\([^,()]+,\s*([^()]*)\)", lambda m: m.group(1), nv)
        nv = re.sub(r"env\([^()]*\)", "0px", nv)
        if nv == v: break
        v = nv
    return v

MATH = re.compile(r"\b(clamp|min|max)\(")

def resolve_math(value, vars_):
    """Replace clamp()/min()/max() (which Chromium 76 lacks) by their value at 1920x1080.
    Other values, including plain calc() and var(), are left alone."""
    if not MATH.search(value):
        return value
    v = substitute(value, vars_)
    for _ in range(60):
        m = re.search(r"\b(clamp|min|max|calc)\(([^()]*)\)", v) or re.search(r"(?<![\w-])\(([^()]*)\)", v)
        if not m: break
        if m.re.groups == 2:
            fn, args = m.group(1), [a.strip() for a in split_top(m.group(2), ",")]
            vals = [to_px(a) for a in args]
            r = {"clamp": lambda a: max(a[0], min(a[1], a[2])), "min": min, "max": max, "calc": lambda a: a[0]}[fn](vals)
        else:
            r = to_px(m.group(1))
        v = v[:m.start()] + num(r) + "px" + v[m.end():]
    return v

# ---------- declarations ----------
PHYS = {"inset-inline-start": "right", "inset-inline-end": "left", "inset-block-start": "top", "inset-block-end": "bottom",
        "margin-inline-start": "margin-right", "margin-inline-end": "margin-left",
        "padding-inline-start": "padding-right", "padding-inline-end": "padding-left",
        "margin-block-start": "margin-top", "margin-block-end": "margin-bottom",
        "padding-block-start": "padding-top", "padding-block-end": "padding-bottom"}
PAIRS = {"inset-inline": ("right", "left"), "inset-block": ("top", "bottom"), "margin-inline": ("margin-right", "margin-left"),
         "margin-block": ("margin-top", "margin-bottom"), "padding-inline": ("padding-right", "padding-left"),
         "padding-block": ("padding-top", "padding-bottom"), "scroll-padding-inline": ("scroll-padding-right", "scroll-padding-left")}

def words(v):
    return [p for p in split_top(v.strip(), " ") if p]

def expand(prop, val, vars_, sel):
    """One declaration -> list of (prop, value) that Chromium 76 understands (RTL page)."""
    pct = re.fullmatch(r"\s*min\(\s*(100%\s*,\s*(.+)|(.+?)\s*,\s*100%)\s*\)\s*", val)
    if pct and prop in ("width", "max-width"):            # min(X,100%) -> width:100% + max-width:X
        cap = resolve_math("max(" + (pct.group(2) or pct.group(3)) + ",0px)", vars_)
        return ([("width", "100%")] if prop == "width" else []) + [("max-width", cap)]
    if MATH.search(val):
        try:
            val = resolve_math(val, vars_)
        except Exception:
            WARN.append("left unresolved: %s { %s: %s }" % (sel, prop, val))
    if prop in PHYS:
        return [(PHYS[prop], val)]
    if prop in PAIRS:
        p = words(val); a, b = PAIRS[prop]
        return [(a, p[0]), (b, p[1] if len(p) > 1 else p[0])]
    if prop == "inset":
        p = words(val)
        t, r, b, l = p * 4 if len(p) == 1 else p + p if len(p) == 2 else p + [p[1]] if len(p) == 3 else p
        return [("top", t), ("right", r), ("bottom", b), ("left", l)]
    return [(prop, val)]

# ---------- stylesheet ----------
def parse(css, media=None):
    """Flat list of rules: (kind, media, head, body). kind is 'rule', 'raw' (keyframes, font-face)."""
    out, i = [], 0
    while i < len(css):
        j = css.find("{", i)
        if j < 0: break
        head = css[i:j].strip()
        if head.startswith("@media") or head.startswith("@supports"):
            d, k = 1, j + 1
            while d and k < len(css):
                d += {"{": 1, "}": -1}.get(css[k], 0); k += 1
            out.append(("open", None, head, None))
            out += parse(css[j + 1:k - 1], head)
            out.append(("close", None, None, None)); i = k; continue
        if head.startswith("@"):
            d, k = 1, j + 1
            while d and k < len(css):
                d += {"{": 1, "}": -1}.get(css[k], 0); k += 1
            out.append(("raw", media, css[i:k].strip(), None)); i = k; continue
        k = css.find("}", j)
        out.append(("rule", media, head, css[j + 1:k])); i = k + 1
    return out

def decls(body):
    res = []
    for d in split_top(body, ";"):
        if ":" in d:
            k, v = d.split(":", 1)
            res.append((k.strip(), v.strip()))
    return res

def transform_css(css):
    css = re.sub(r"/\*[\s\S]*?\*/", "", css)
    rules = parse(css)
    vars_ = {}
    for kind, media, head, body in rules:
        if kind == "rule" and head == ":root" and not media:
            for k, v in decls(body):
                if k.startswith("--"): vars_[k] = v
    for k in list(vars_):
        try: vars_[k] = resolve_math(vars_[k], vars_)
        except Exception: WARN.append("variable left unresolved: %s" % k)

    display = {}                                  # selector -> display, to find flex containers
    for kind, media, head, body in rules:
        if kind != "rule": continue
        for k, v in decls(body):
            if k == "display":
                for s in split_top(head, ","): display.setdefault(s.strip(), set()).add(v)
    for s, ds in display.items():
        if any("flex" in d for d in ds) and any("grid" in d for d in ds):
            WARN.append("display switches between flex and grid: %s %s" % (s, ds))

    def display_of(sel, own):
        if own: return own
        for s in split_top(sel, ","):
            s = s.strip()
            base = re.match(r"^(.*?)[.:\[][\w-]+[^.:\[]*$", s)  # .prov.sm -> .prov
            if base and base.group(1) in display:
                return sorted(display[base.group(1)])[0]
        return ""

    out, extra, ratios = [], [], []
    for kind, media, head, body in rules:
        if kind == "open": out.append(head + "{"); continue
        if kind == "close": out.append("}"); continue
        if kind == "raw": out.append(head); continue
        props, lines = {}, []
        for k, v in decls(body):
            for pk, pv in expand(k, v, vars_, head):
                props[pk] = pv; lines.append((pk, pv))
        disp = display_of(head, props.get("display", ""))
        gap = props.get("gap")
        if gap and "flex" in disp:
            lines = [(k, v) for k, v in lines if k != "gap"]
            g = words(gap); rg, cg = g[0], (g[1] if len(g) > 1 else g[0])
            col = props.get("flex-direction", "").startswith("column")
            wrap = "wrap" in props.get("flex-wrap", "") or "wrap" in props.get("flex-flow", "")
            for s in split_top(head, ","):
                s = s.strip()
                rule = ("%s>*+*{margin-top:%s}" % (s, rg)) if col else ("%s>*+*{margin-right:%s}" % (s, cg))
                if wrap and not col and rg not in ("0", "0px"):
                    rule += "%s>*{margin-bottom:%s}" % (s, rg)
                extra.append(("@media " + media[6:].strip() + "{" + rule + "}") if media and media.startswith("@media") else rule)
        if "aspect-ratio" in props:
            m = re.match(r"\s*([\d.]+)\s*(?:/\s*([\d.]+))?", props["aspect-ratio"])
            if m:
                ratio = float(m.group(1)) / float(m.group(2) or 1)
                for s in split_top(head, ","):
                    s = s.strip()
                    if "::" in s or re.search(r":(hover|focus|active|focus-within|focus-visible)", s):
                        continue
                    ratios.append([s, round(ratio, 5), media[6:].strip() if media and media.startswith("@media") else None])
        out.append(head.replace(":focus-visible", ":focus") + "{" + ";".join("%s:%s" % kv for kv in lines) + "}")
    return "\n".join(out) + "\n" + "\n".join(extra) + "\n", ratios

# ---------- fonts ----------
def font_css(dst):
    faces = []
    for fam, weights in (("ibm-plex-sans-arabic", (400, 500, 600, 700)), ("cinzel", (600, 700))):
        for w in weights:
            css = open(os.path.join(FONTS, fam, "%d.css" % w), encoding="utf-8").read()
            for face in re.findall(r"@font-face\s*\{[^}]*\}", css):
                f = re.search(r"url\(\./files/([^)]+\.woff2)\)", face)
                if not f or not re.search(r"-(arabic|latin)-%d-normal\.woff2$" % w, f.group(1)):
                    continue
                shutil.copy(os.path.join(FONTS, fam, "files", f.group(1)), os.path.join(dst, f.group(1)))
                faces.append(re.sub(r"src:[^;]*;", "src:url(fonts/%s) format('woff2');" % f.group(1), face))
    return "\n".join(faces) + "\n"

# aspect-ratio for Chromium < 88: set the height from the width, re-checked after DOM and visibility changes.
AR_POLYFILL = r"""(function(){if(window.CSS&&CSS.supports&&CSS.supports('aspect-ratio','1/1'))return;
var R=%s,last=new WeakMap(),pending=false;
function fix(){pending=false;var map=new Map();
for(var i=0;i<R.length;i++){var r=R[i];if(r[2]&&!matchMedia(r[2]).matches)continue;var els;try{els=document.querySelectorAll(r[0]);}catch(e){continue;}
for(var j=0;j<els.length;j++)map.set(els[j],r[1]);}
var todo=[];map.forEach(function(ratio,el){var w=el.offsetWidth;if(w)todo.push([el,w,ratio]);});
for(var k=0;k<todo.length;k++){var t=todo[k],h=(t[1]/t[2]).toFixed(2)+'px';if(last.get(t[0])!==h){t[0].style.height=h;last.set(t[0],h);}}}
function q(){if(!pending){pending=true;requestAnimationFrame(fix);}}
new MutationObserver(q).observe(document.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:['hidden','open','class']});
addEventListener('resize',q);addEventListener('load',q);if(document.fonts&&document.fonts.ready)document.fonts.ready.then(q);q();})();
"""

def main():
    html = open(os.path.join(ROOT, "index.html"), encoding="utf-8").read()
    css = re.search(r"<style>([\s\S]*?)</style>", html).group(1)
    js = re.findall(r"<script>([\s\S]*?)</script>", html)[-1]
    if os.path.isdir(OUT): shutil.rmtree(OUT)
    os.makedirs(os.path.join(OUT, "fonts"))
    shutil.copytree(os.path.join(ROOT, "assets"), os.path.join(OUT, "assets"))
    tv_css, ratios = transform_css(css)
    open(os.path.join(OUT, "style.css"), "w", encoding="utf-8").write(font_css(os.path.join(OUT, "fonts")) + tv_css)
    raw = os.path.join(OUT, "app.src.js"); open(raw, "w", encoding="utf-8").write(js)
    subprocess.run(["npx", "--yes", "esbuild@0.24.0", raw, "--target=chrome76", "--log-level=warning",
                    "--outfile=" + os.path.join(OUT, "app.js")], check=True, cwd=HERE)
    os.remove(raw)
    app = open(os.path.join(OUT, "app.js"), encoding="utf-8").read()
    open(os.path.join(OUT, "app.js"), "w", encoding="utf-8").write(AR_POLYFILL % json.dumps(ratios) + app)
    page = re.sub(r"<link rel=\"preconnect\"[^>]*>\s*", "", html)
    page = re.sub(r"<link rel=\"stylesheet\" href=\"https://fonts\.googleapis\.com[^>]*>\s*", "", page)
    page = page.replace(re.search(r"<style>[\s\S]*?</style>", page).group(0), '<link rel="stylesheet" href="style.css">', 1)
    page = page.replace(re.findall(r"<script>[\s\S]*?</script>", page)[-1], '<script src="app.js"></script>', 1)
    open(os.path.join(OUT, "index.html"), "w", encoding="utf-8").write(page)
    for f in ("config.xml", "icon.png"):
        shutil.copy(os.path.join(HERE, f), os.path.join(OUT, f))
    wgt = os.path.join(HERE, "HudaifFlix.wgt")
    if os.path.exists(wgt): os.remove(wgt)
    with zipfile.ZipFile(wgt, "w", zipfile.ZIP_DEFLATED) as z:
        for base, _, files in os.walk(OUT):
            for f in sorted(files):
                full = os.path.join(base, f); z.write(full, os.path.relpath(full, OUT))
    flat = tv_css.replace("minmax(", "")
    left = [f for f in ("clamp(", "min(", "max(", "inset:", "-inline", "-block-", ":focus-visible", "aspect-ratio") if f in flat and f != "aspect-ratio"]
    print("built", os.path.relpath(wgt, ROOT), "| aspect-ratio fallbacks:", ratios)
    print("leftover modern CSS:", left or "none")
    for w in WARN: print("WARNING:", w)

if __name__ == "__main__":
    main()
