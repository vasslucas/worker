/**
 * gallium + cellar: single-file Cloudflare Worker
 * ---------------------------------------------------------------
 *  /                   chooser page (cellar home when ?url= or ?q= is present)
 *  /gallium            gallium AI chat app
 *  /cellar             cellar home page (web proxy)
 *  /p/<origin>/<path>  proxied pages (HTML/CSS rewriting, cookies, redirects, Range)
 *  /ws?url=...         cellar websocket relay
 *  /ws                 gallium AI socket (ALL AI traffic: models, chat, stream, stop, ping)
 *  /tunnel             cellar fetch tunnel
 *  /suggest?q=         search suggestions
 */

/* ---- gallium upstream keys (round-robin with cooldowns) ---- */
const GROQ_KEYS = ["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"];
const POLLINATIONS_KEYS = ["sk_VNid54RYQB5fCMbWWWORMoiwYX43bC9M"];

const CONFIG = {
  // Set a password to lock the whole worker behind a styled login page. "" = no lock.
  PASSWORD: "",

  // Route page fetch() GETs through one multiplexed channel (falls back to plain HTTP)
  TUNNEL_FETCH: true,
  CHUNK: 192 * 1024,

  // Return empty responses for common ad/tracking hosts
  BLOCK_TRACKERS: true,

  // Search engines (first one is the default)
  ENGINES: [
    { id: "ddg", name: "duckduckgo", url: "https://duckduckgo.com/html/?q=" },
    { id: "brave", name: "brave", url: "https://search.brave.com/search?q=" },
    { id: "bing", name: "bing", url: "https://www.bing.com/search?q=" },
    { id: "google", name: "google", url: "https://www.google.com/search?q=" },
  ],

  BLOCKED_HOSTS: ["localhost", "0.0.0.0", "[::1]"],
};

const TRACKERS = [
  "doubleclick.net", "googlesyndication.com", "googleadservices.com", "google-analytics.com",
  "adservice.google.com", "scorecardresearch.com", "taboola.com", "outbrain.com", "adnxs.com",
  "criteo.com", "criteo.net", "hotjar.com", "amazon-adsystem.com", "pubmatic.com",
  "rubiconproject.com", "moatads.com", "adsrvr.org", "quantserve.com", "mixpanel.com",
];

const PREFIX = "/p/";
const enc = encodeURIComponent;

/* ============================== ROUTER ============================== */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    let path = url.pathname;
    if (path.length > 1 && path.endsWith("/") && !path.startsWith(PREFIX)) path = path.replace(/\/+$/, "") || "/";
    try {
      if (CONFIG.PASSWORD) {
        if (path === "/unlock" && request.method === "POST") return await unlock(request, url);
        if (!(await isAuthed(request))) {
          if (request.method !== "GET" || request.headers.get("Upgrade")) return txt("Locked", 401);
          return lockPage(false);
        }
      }

      // /ws is shared: ?url= means cellar's relay, otherwise gallium's AI socket
      if (path === "/ws") {
        if (url.searchParams.has("url")) return await handleWs(request, url);
        return handleGallium(request);
      }
      if (path === "/tunnel") return handleTunnel(request);

      if (path.startsWith(PREFIX)) {
        const target = parseProxyPath(url);
        if (!target) return fail(400, "Bad address", "That proxy URL couldn't be understood.");
        return await handleHttp(request, target, url);
      }

      if (path === "/suggest") return await suggest(url);

      if (path === "/") {
        // cellar's "/?url=" and "/?q=" redirect handling keeps working on "/"
        if (url.searchParams.has("url") || url.searchParams.has("q")) return htmlRes(HOME_HTML);
        return htmlRes(chooserPage());
      }
      if (path === "/gallium") return htmlRes(galliumPage());
      if (path === "/cellar") return htmlRes(HOME_HTML);

      // Fallback for root-relative URLs that escaped rewriting (only after all known routes)
      const m = /(?:^|;\s*)__px_origin=([^;]+)/.exec(request.headers.get("cookie") || "");
      if (m) {
        try {
          const origin = decodeURIComponent(m[1]);
          if (/^https?:\/\/[^\/]+$/.test(origin)) {
            return redirect(PREFIX + enc(origin) + path + url.search, true);
          }
        } catch {}
      }
      return fail(404, "Nothing here", "This page doesn't exist.", "/", "go home");
    } catch (err) {
      return fail(502, "Couldn't reach that site", err && err.message ? err.message : String(err));
    }
  },
};

/* ============================== HELPERS ============================== */

function txt(s, status = 200) {
  return new Response(s, { status, headers: { "content-type": "text/plain;charset=utf-8" } });
}
function htmlRes(body, status = 200) {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html;charset=utf-8", "cache-control": "no-store" },
  });
}
function redirect(location, noStore) {
  const h = { location };
  if (noStore) h["cache-control"] = "no-store";
  return new Response(null, { status: 302, headers: h });
}
function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
function shell(title, inner) {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>' +
    esc(title) + "</title><style>" + PAGE_CSS + "</style></head><body><main>" + inner + "</main></body></html>";
}
function fail(status, headline, detail, href, label) {
  const body = '<div class="code">' + status + "</div><h1>" + esc(headline) + "</h1><p>" + esc(detail || "") + '</p><a class="btn" href="' +
    esc(href || "/cellar") + '">' + esc(label || "back to cellar") + "</a>";
  return new Response(shell(status + " - cellar", body), {
    status,
    headers: { "content-type": "text/html;charset=utf-8", "cache-control": "no-store" },
  });
}
function proxify(u, base) {
  try {
    const abs = new URL(u, base);
    if (abs.protocol !== "http:" && abs.protocol !== "https:") return u;
    return PREFIX + enc(abs.origin) + abs.pathname + abs.search + abs.hash;
  } catch {
    return u;
  }
}
function parseProxyPath(url) {
  const rest = url.pathname.slice(PREFIX.length);
  const i = rest.indexOf("/");
  const originEnc = i < 0 ? rest : rest.slice(0, i);
  const path = i < 0 ? "/" : rest.slice(i);
  let origin;
  try { origin = decodeURIComponent(originEnc); } catch { return null; }
  if (!/^https?:\/\/[^\/]+$/.test(origin)) return null;
  try { return new URL(origin + path + url.search); } catch { return null; }
}
function isBlocked(t, self) {
  if (t.protocol !== "http:" && t.protocol !== "https:") return true;
  const h = t.hostname.toLowerCase();
  if (self && h === self.hostname.toLowerCase()) return true; // no proxy loops
  if (CONFIG.BLOCKED_HOSTS.includes(h)) return true;
  if (/\.(local|localhost|internal|lan|home\.arpa)$/.test(h)) return true;
  if (/^(127|10|0)\.|^192\.168\.|^169\.254\.|^172\.(1[6-9]|2\d|3[01])\.|^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h)) return true;
  if (h.startsWith("[") && /^\[(::1?|::ffff:|f[cd]|fe[89ab])/.test(h)) return true;
  return false;
}
function isTracker(host) {
  if (!CONFIG.BLOCK_TRACKERS) return false;
  const h = host.toLowerCase();
  return TRACKERS.some((d) => h === d || h.endsWith("." + d));
}
function b64(u8) {
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
function unb64(s) {
  const b = atob(s);
  const u = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
  return u;
}

/* ============================== PASSWORD LOCK ============================== */

async function sha(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("cellar:" + s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function isAuthed(request) {
  const m = /(?:^|;\s*)cellar_auth=([a-f0-9]+)/.exec(request.headers.get("cookie") || "");
  return !!m && m[1] === (await sha(CONFIG.PASSWORD));
}
function lockPage(bad) {
  const inner =
    '<div class="code" style="font-size:clamp(52px,13vw,96px)">cellar</div>' +
    '<form method="POST" action="/unlock"><input type="password" name="p" placeholder="password" autofocus autocomplete="current-password"' +
    (bad ? ' class="bad"' : "") + '><button class="btn" type="submit">enter</button></form>' +
    (bad ? '<p style="margin-top:18px">wrong password</p>' : "");
  return new Response(shell("cellar", inner), {
    status: 401,
    headers: { "content-type": "text/html;charset=utf-8", "cache-control": "no-store" },
  });
}
async function unlock(request, url) {
  let p = "";
  try { p = (await request.formData()).get("p") || ""; } catch {}
  if (String(p) !== CONFIG.PASSWORD) return lockPage(true);
  const h = new Headers({ location: "/", "cache-control": "no-store" });
  h.append("set-cookie", "cellar_auth=" + (await sha(CONFIG.PASSWORD)) + "; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax" + (url.protocol === "https:" ? "; Secure" : ""));
  return new Response(null, { status: 303, headers: h });
}

/* ============================== SUGGEST ============================== */

async function suggest(url) {
  const q = (url.searchParams.get("q") || "").trim().slice(0, 100);
  let out = [];
  if (q) {
    try {
      const r = await fetch("https://duckduckgo.com/ac/?type=list&q=" + enc(q), {
        headers: { "user-agent": "Mozilla/5.0" },
        cf: { cacheEverything: true, cacheTtl: 300 },
      });
      const j = await r.json();
      if (Array.isArray(j[1])) out = j[1].slice(0, 6).map(String);
    } catch {}
  }
  return new Response(JSON.stringify(out), {
    headers: { "content-type": "application/json", "cache-control": "private, max-age=120" },
  });
}

/* ============================== UPSTREAM REQUEST ============================== */

const SKIP_REQ = new Set([
  "host", "origin", "referer", "cookie", "accept-encoding", "connection", "upgrade",
  "content-length", "x-real-ip", "true-client-ip", "via", "forwarded", "x-forwarded-for",
  "x-forwarded-host", "x-forwarded-proto", "x-forwarded-port",
]);

function buildUpstreamHeaders(src, target, cookieOverride) {
  const h = new Headers();
  for (const [k, v] of src) {
    const key = k.toLowerCase();
    if (SKIP_REQ.has(key)) continue;
    if (key.startsWith("cf-") || key.startsWith("x-forwarded")) continue;
    h.set(k, v);
  }
  const ck = (cookieOverride !== undefined ? cookieOverride : src.get("cookie") || "")
    .split(/;\s*/)
    .filter((c) => c && !c.startsWith("__px_origin=") && !c.startsWith("cellar_auth="))
    .join("; ");
  if (ck) h.set("cookie", ck);

  let refererReal = null;
  const ref = src.get("referer");
  if (ref) {
    try {
      const r = parseProxyPath(new URL(ref));
      if (r) refererReal = r;
    } catch {}
  }
  if (src.get("origin")) h.set("origin", refererReal ? refererReal.origin : target.origin);
  h.set("referer", refererReal ? refererReal.href : target.origin + "/");
  return h;
}

async function handleHttp(request, target, selfUrl) {
  if (isBlocked(target, selfUrl)) return fail(403, "Blocked", "That address can't be opened through cellar.");
  if (isTracker(target.hostname)) {
    return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*" } });
  }
  const method = request.method.toUpperCase();
  const init = {
    method,
    headers: buildUpstreamHeaders(request.headers, target),
    redirect: "manual",
  };
  if (method !== "GET" && method !== "HEAD") init.body = request.body;
  const resp = await fetch(target.href, init);
  return buildResponse(resp, target, { secure: selfUrl.protocol === "https:" });
}

/* ============================== RESPONSE REWRITING ============================== */

const STRIP_RES = [
  "content-security-policy", "content-security-policy-report-only", "x-frame-options",
  "cross-origin-opener-policy", "cross-origin-embedder-policy", "cross-origin-resource-policy",
  "strict-transport-security", "report-to", "nel", "permissions-policy", "alt-svc",
];

function rewriteCookie(c, target) {
  const prefix = PREFIX + enc(target.origin);
  const parts = c.split(";").map((s) => s.trim());
  const out = [parts[0]];
  let path = "/";
  for (const p of parts.slice(1)) {
    const eq = p.indexOf("=");
    const key = (eq < 0 ? p : p.slice(0, eq)).toLowerCase();
    if (key === "domain" || key === "samesite") continue;
    if (key === "path") { path = (eq < 0 ? "/" : p.slice(eq + 1)) || "/"; continue; }
    out.push(p);
  }
  out.push("Path=" + prefix + (path.startsWith("/") ? path : "/" + path));
  out.push("SameSite=Lax");
  return out.join("; ");
}

function rewriteCss(css, base) {
  return css
    .replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (m, q, u) => {
      u = u.trim();
      if (!u || u.startsWith("data:") || u.startsWith("#") || u.startsWith(PREFIX)) return m;
      return "url(" + q + proxify(u, base) + q + ")";
    })
    .replace(/@import\s+(['"])(.*?)\1/gi, (m, q, u) => "@import " + q + proxify(u, base) + q);
}

function rewriteSrcset(v, base) {
  return v.split(",").map((s) => {
    const t = s.trim();
    if (!t) return t;
    const [u, ...d] = t.split(/\s+/);
    return [proxify(u, base), ...d].join(" ");
  }).join(", ");
}

const URL_ATTRS = ["href", "src", "action", "poster", "data-src", "formaction"];

function makeRewriter(target) {
  const base = target.href;
  const cfg = { base, tunnel: CONFIG.TUNNEL_FETCH, engines: CONFIG.ENGINES };
  const inject = "<script>" + CLIENT_JS + "(" + JSON.stringify(cfg).replace(/</g, "\\u003c") + ")</script>";

  return new HTMLRewriter()
    .on("html", { element(e) { e.prepend(inject, { html: true }); } })
    .on("*", {
      element(el) {
        for (const a of URL_ATTRS) {
          const v = el.getAttribute(a);
          if (v && v.trim() && !v.trim().startsWith("#") && !v.startsWith(PREFIX)) el.setAttribute(a, proxify(v.trim(), base));
        }
        const ss = el.getAttribute("srcset");
        if (ss) el.setAttribute("srcset", rewriteSrcset(ss, base));
        const st = el.getAttribute("style");
        if (st) el.setAttribute("style", rewriteCss(st, base));
        el.removeAttribute("integrity");
        el.removeAttribute("nonce");
      },
    })
    .on("meta[http-equiv]", {
      element(el) {
        if ((el.getAttribute("http-equiv") || "").toLowerCase() !== "refresh") return;
        const c = el.getAttribute("content") || "";
        el.setAttribute("content", c.replace(/(url\s*=\s*)(['"]?)([^'";]+)\2/i, (m, p, q, u) => p + q + proxify(u.trim(), base) + q));
      },
    })
    .on("style", new StyleHandler(base));
}

class StyleHandler {
  constructor(base) { this.base = base; this.buf = ""; }
  text(t) {
    this.buf += t.text;
    if (t.lastInTextNode) { t.replace(rewriteCss(this.buf, this.base), { html: true }); this.buf = ""; }
    else t.remove();
  }
}

async function buildResponse(resp, target, opts = {}) {
  const h = new Headers(resp.headers);
  for (const k of STRIP_RES) h.delete(k);

  h.delete("set-cookie");
  const cookies = typeof resp.headers.getSetCookie === "function" ? resp.headers.getSetCookie() : [];
  for (const c of cookies) h.append("set-cookie", rewriteCookie(c, target));

  const loc = h.get("location");
  if (loc) h.set("location", proxify(loc, target.href));

  h.set("access-control-allow-origin", "*");
  h.set("access-control-expose-headers", "*");

  const ct = (h.get("content-type") || "").toLowerCase();
  const init = { status: resp.status, statusText: resp.statusText, headers: h };

  if (ct.includes("text/html") || ct.includes("application/xhtml")) {
    h.delete("content-length"); h.delete("content-encoding");
    h.delete("etag"); h.delete("last-modified");
    h.set("cache-control", "no-store");
    if (!opts.tunnel) {
      h.append("set-cookie", "__px_origin=" + enc(target.origin) + "; Path=/; SameSite=Lax" + (opts.secure ? "; Secure" : ""));
    }
    return makeRewriter(target).transform(new Response(resp.body, init));
  }
  if (ct.includes("text/css")) {
    const text = await resp.text();
    h.delete("content-length"); h.delete("content-encoding");
    return new Response(rewriteCss(text, target.href), init);
  }
  return new Response(resp.body, init);
}

/* ============================== REALTIME RELAY (/ws?url=) ============================== */

async function handleWs(request, url) {
  if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket") return txt("Expected upgrade", 426);
  let t;
  try { t = new URL(url.searchParams.get("url")); } catch { return txt("Bad url", 400); }
  if (t.protocol === "wss:") t.protocol = "https:";
  else if (t.protocol === "ws:") t.protocol = "http:";
  if (isBlocked(t, url)) return txt("Blocked target", 403);

  const headers = new Headers({ Upgrade: "websocket", Origin: t.origin });
  const ua = request.headers.get("user-agent");
  if (ua) headers.set("user-agent", ua);
  const sp = request.headers.get("sec-websocket-protocol");
  if (sp) headers.set("sec-websocket-protocol", sp);

  const up = await fetch(t.href, { headers });
  const upstream = up.webSocket;
  if (!upstream) return txt("Upstream refused (status " + up.status + ")", 502);

  const [client, server] = Object.values(new WebSocketPair());
  server.accept();
  upstream.accept();

  server.addEventListener("message", (e) => { try { upstream.send(e.data); } catch {} });
  upstream.addEventListener("message", (e) => { try { server.send(e.data); } catch {} });
  const closer = (other) => (e) => {
    const bad = !e.code || e.code === 1005 || e.code === 1006 || e.code === 1015;
    try { other.close(bad ? 1000 : e.code, e.reason); } catch {}
  };
  server.addEventListener("close", closer(upstream));
  upstream.addEventListener("close", closer(server));
  server.addEventListener("error", () => { try { upstream.close(1011); } catch {} });
  upstream.addEventListener("error", () => { try { server.close(1011); } catch {} });

  const rh = new Headers();
  const chosen = up.headers.get("sec-websocket-protocol");
  if (chosen) rh.set("sec-websocket-protocol", chosen);
  return new Response(null, { status: 101, webSocket: client, headers: rh });
}

/* ============================== FETCH TUNNEL (/tunnel) ============================== */

function handleTunnel(request) {
  if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket") return txt("Expected upgrade", 426);
  const [client, server] = Object.values(new WebSocketPair());
  server.accept();
  server.addEventListener("message", (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    tunnelRequest(m, server, request);
  });
  return new Response(null, { status: 101, webSocket: client });
}

async function tunnelRequest(m, server, request) {
  const send = (o) => { try { server.send(JSON.stringify(o)); } catch {} };
  const id = m.id;
  try {
    const self = new URL(request.url);
    const target = parseProxyPath(new URL(m.url, self));
    if (!target || isBlocked(target, self)) return send({ id, type: "error", message: "Blocked or invalid URL" });
    if (isTracker(target.hostname)) {
      send({ id, type: "head", status: 204, statusText: "", headers: [], cookies: [] });
      return send({ id, type: "end" });
    }

    const method = (m.method || "GET").toUpperCase();
    const src = new Headers(m.headers || []);
    if (m.referer) src.set("referer", m.referer);
    const init = { method, headers: buildUpstreamHeaders(src, target, m.cookie || ""), redirect: "follow" };
    if (m.body && method !== "GET" && method !== "HEAD") init.body = unb64(m.body);

    const resp = await fetch(target.href, init);
    const finalUrl = new URL(resp.url || target.href);
    const out = await buildResponse(resp, finalUrl, { tunnel: true });

    const hdrs = [];
    out.headers.forEach((v, k) => {
      if (k !== "set-cookie" && k !== "content-length" && k !== "content-encoding") hdrs.push([k, v]);
    });
    send({
      id, type: "head", status: out.status, statusText: out.statusText,
      headers: hdrs, cookies: out.headers.getSetCookie ? out.headers.getSetCookie() : [],
    });

    if (out.body) {
      const reader = out.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (let i = 0; i < value.length; i += CONFIG.CHUNK) {
          send({ id, type: "body", data: b64(value.subarray(i, i + CONFIG.CHUNK)) });
        }
      }
    }
    send({ id, type: "end" });
  } catch (e) {
    send({ id, type: "error", message: String(e && e.message ? e.message : e) });
  }
}

/* ============================== SHARED PAGE-SIDE LOGIC ============================== */
/* Used by both the home page and the injected client script (storage, cloak, panic key, navigation).
   Written without backticks or dollar-brace so it can live inside String.raw. */

const SHARED_JS = String.raw`function CELLAR(engines){
var KEY="cellar.v1";
var DEF={engine:engines[0].id,panic:"https://docs.google.com/",cloak:"none",art:"full",recents:[],pins:[]};
function ico(bg,d){return "data:image/svg+xml,"+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="5" fill="'+bg+'"/><path d="'+d+'" fill="#fff"/></svg>')}
var CLOAKS={
  none:{name:"off"},
  docs:{name:"docs",title:"Untitled document - Google Docs",icon:ico("#4285f4","M7 4h7l4 4v12H7z")},
  drive:{name:"drive",title:"My Drive - Google Drive",icon:ico("#f4b400","M12 5l7 12H5z")},
  classroom:{name:"classroom",title:"Classes",icon:ico("#0f9d58","M5 6h14v9H5zM9 17h6v2H9z")},
  tab:{name:"new tab",title:"New Tab",icon:ico("#5f6368","M5 11h14v2H5z")}
};

function load(){
  var s={};
  try{s=JSON.parse(localStorage.getItem(KEY)||"{}")||{}}catch(e){}
  for(var k in DEF)if(s[k]==null)s[k]=Array.isArray(DEF[k])?[]:DEF[k];
  if(!Array.isArray(s.recents))s.recents=[];
  if(!Array.isArray(s.pins))s.pins=[];
  return s;
}
function save(s){try{localStorage.setItem(KEY,JSON.stringify(s))}catch(e){}}
function set(k,v){var s=load();s[k]=v;save(s)}

function engineUrl(){
  var id=load().engine;
  for(var i=0;i<engines.length;i++)if(engines[i].id===id)return engines[i].url;
  return engines[0].url;
}
function norm(v){
  v=(v||"").trim();
  if(/^https?:\/\//i.test(v))return v;
  if(/^[^\s\/]+\.[^\s\/]{2,}(\/.*)?$/.test(v))return "https://"+v;
  return engineUrl()+encodeURIComponent(v);
}
function dest(u){
  try{var a=new URL(u);return "/p/"+encodeURIComponent(a.origin)+a.pathname+a.search+a.hash}catch(e){return "/cellar"}
}
function go(v,replace){
  var d=dest(norm(v));
  if(replace)location.replace(d);else location.href=d;
}

function addRecent(href,title){
  try{
    var u=new URL(href),s=load(),o=u.origin;
    s.recents=s.recents.filter(function(r){return r.o!==o});
    s.recents.unshift({o:o,h:href.split("#")[0],t:String(title||u.hostname).slice(0,60)});
    s.recents=s.recents.slice(0,8);
    save(s);
  }catch(e){}
}
function isPinned(href){
  var h=href.split("#")[0];
  return load().pins.some(function(p){return p.h===h});
}
function togglePin(href,title){
  var s=load(),h=href.split("#")[0],had=s.pins.some(function(p){return p.h===h});
  if(had)s.pins=s.pins.filter(function(p){return p.h!==h});
  else{s.pins.unshift({h:h,t:String(title||h).slice(0,60)});s.pins=s.pins.slice(0,12)}
  save(s);
  return !had;
}
function unrecent(o){var s=load();s.recents=s.recents.filter(function(r){return r.o!==o});save(s)}
function unpin(h){var s=load();s.pins=s.pins.filter(function(p){return p.h!==h});save(s)}
function clearData(){var s=load();s.recents=[];s.pins=[];save(s)}

var cObs=null,orig=null,removed=[];
function applyCloak(){
  var c=CLOAKS[load().cloak];
  if(orig===null)orig=document.title;
  if(cObs){cObs.disconnect();cObs=null}
  var head=document.head;
  if(!head)return;
  var mine=head.querySelector("link[data-cl]");
  if(!c||!c.title){
    if(mine)mine.remove();
    removed.forEach(function(n){head.appendChild(n)});
    removed=[];
    if(orig)document.title=orig;
    return;
  }
  function apply(){
    if(cObs)cObs.disconnect();
    if(document.title!==c.title)document.title=c.title;
    var icons=head.querySelectorAll("link[rel~='icon']");
    var m=head.querySelector("link[data-cl]");
    for(var i=0;i<icons.length;i++)if(icons[i]!==m){removed.push(icons[i]);icons[i].remove()}
    if(!m){m=document.createElement("link");m.rel="icon";m.setAttribute("data-cl","");head.appendChild(m)}
    if(m.href!==c.icon)m.href=c.icon;
    if(cObs)cObs.observe(head,{childList:true,subtree:true,characterData:true});
  }
  cObs=new MutationObserver(apply);
  apply();
}

var panicArmed=false;
function armPanic(){
  if(panicArmed)return;
  panicArmed=true;
  var last=0;
  addEventListener("keydown",function(e){
    if(e.key!=="\u0060"||e.ctrlKey||e.metaKey||e.altKey)return;
    var t=e.target,n=t&&t.tagName;
    if(n==="INPUT"||n==="TEXTAREA"||n==="SELECT"||(t&&t.isContentEditable))return;
    var now=Date.now();
    if(now-last<600){var u=load().panic;if(u)location.replace(u)}
    last=now;
  },true);
}

function launch(){
  var s=load(),c=CLOAKS[s.cloak]||{};
  var w=window.open("about:blank","_blank");
  if(!w)return false;
  try{
    var d=w.document;
    d.title=c.title||"Home";
    if(c.icon){var l=d.createElement("link");l.rel="icon";l.href=c.icon;d.head.appendChild(l)}
    d.body.style.cssText="margin:0;background:#000";
    var f=d.createElement("iframe");
    f.src=location.origin+"/cellar";
    f.style.cssText="position:fixed;inset:0;width:100%;height:100%;border:0";
    d.body.appendChild(f);
  }catch(e){return false}
  if(s.panic)location.replace(s.panic);
  return true;
}

return {engines:engines,CLOAKS:CLOAKS,load:load,save:save,set:set,norm:norm,dest:dest,go:go,
  addRecent:addRecent,isPinned:isPinned,togglePin:togglePin,unrecent:unrecent,unpin:unpin,clearData:clearData,
  applyCloak:applyCloak,armPanic:armPanic,launch:launch};
}`;

/* ============================== CLIENT SCRIPT (injected into proxied pages) ============================== */

const DOCK_CSS = String.raw`
:host{all:initial}
*{box-sizing:border-box}
.root{font:13px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#eee}
.tab{position:fixed;top:0;left:50%;width:54px;height:14px;margin-left:-27px;border-radius:0 0 12px 12px;background:rgba(12,12,12,.8);-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,.16);border-top:0;cursor:pointer;display:grid;place-items:center;opacity:.5;transition:opacity .3s,height .35s cubic-bezier(.2,.9,.2,1),transform .5s cubic-bezier(.2,.9,.2,1)}
.tab:hover{opacity:1;height:20px}
.tab i{display:block;width:18px;height:2px;border-radius:2px;background:#cfcfcf;transition:width .35s}
.tab:hover i{width:26px}
.open .tab{transform:translateY(-130%);pointer-events:none}
.bar{position:fixed;top:0;left:50%;display:flex;align-items:center;gap:4px;width:min(680px,94vw);height:48px;padding:0 8px;border-radius:0 0 20px 20px;background:rgba(10,10,10,.92);-webkit-backdrop-filter:blur(18px);backdrop-filter:blur(18px);border:1px solid rgba(255,255,255,.16);border-top:0;box-shadow:0 20px 60px rgba(0,0,0,.65);transform:translate(-50%,-115%);opacity:0;pointer-events:none;transition:transform .6s cubic-bezier(.2,.9,.2,1),opacity .35s;overflow:hidden}
.open .bar{transform:translate(-50%,0);opacity:1;pointer-events:auto}
.bar::after{content:"";position:absolute;left:0;bottom:0;height:2px;width:35%;background:linear-gradient(90deg,transparent,#fff,transparent);opacity:0;transform:translateX(-100%)}
.busy .bar::after{opacity:1;animation:sweep 1s ease-in-out infinite}
@keyframes sweep{to{transform:translateX(300%)}}
.b{all:unset;box-sizing:border-box;flex:none;width:32px;height:32px;border-radius:10px;display:grid;place-items:center;color:#aaa;cursor:pointer;transition:background .25s,color .25s,transform .35s cubic-bezier(.2,.9,.2,1)}
.b:hover{background:rgba(255,255,255,.1);color:#fff;transform:translateY(-1px)}
.b:active{transform:scale(.88)}
.b svg{transition:transform .5s cubic-bezier(.2,.9,.2,1)}
#rl:hover svg{transform:rotate(180deg)}
#hm:hover svg{transform:translateY(-2px)}
.b.on{color:#fff}
.b.on svg{fill:#fff}
input{flex:1;min-width:0;height:32px;margin:0 4px;padding:0 12px;border:1px solid transparent;border-radius:10px;background:rgba(255,255,255,.06);color:#eee;font:inherit;outline:none;transition:border-color .3s,background .3s}
input:focus{background:rgba(255,255,255,.1);border-color:rgba(255,255,255,.35)}
.open .bar>*{animation:pop .55s cubic-bezier(.2,.9,.2,1) calc(.12s + var(--k)*35ms) backwards}
@keyframes pop{from{opacity:0;transform:translateY(-10px)}}
`;

/* Written without backticks / dollar-brace (except the intended substitutions) so it can live inside String.raw */
const CLIENT_JS = String.raw`(function(cfg){
if (window.__pxLoaded) return; window.__pxLoaded = true;
${SHARED_JS}
var CL = CELLAR(cfg.engines);
var PREFIX = "/p/";
var _fetch = window.fetch.bind(window);
var _WS = window.WebSocket;
var _xhrOpen = XMLHttpRequest.prototype.open;
var onNav = function(){};

function real(){
  try {
    if (location.pathname.indexOf(PREFIX) === 0) {
      var rest = location.pathname.slice(PREFIX.length);
      var i = rest.indexOf("/");
      var o = decodeURIComponent(i < 0 ? rest : rest.slice(0, i));
      return new URL(o + (i < 0 ? "/" : rest.slice(i)) + location.search + location.hash);
    }
  } catch (e) {}
  return new URL(cfg.base);
}

function toProxy(u){
  if (u == null) return u;
  var s = String(u);
  if (!s) return s;
  if (/^(data:|blob:|javascript:|about:|mailto:|tel:|#)/i.test(s)) return s;
  if (s.indexOf(PREFIX) === 0) return s;
  if (s.indexOf(location.origin + PREFIX) === 0) return s.slice(location.origin.length);
  try {
    var abs = new URL(s, real());
    if (abs.protocol !== "http:" && abs.protocol !== "https:") return s;
    if (abs.origin === location.origin) {
      if (abs.pathname.indexOf(PREFIX) === 0) return abs.pathname + abs.search + abs.hash;
      abs = new URL(abs.pathname + abs.search + abs.hash, real());
    }
    return PREFIX + encodeURIComponent(abs.origin) + abs.pathname + abs.search + abs.hash;
  } catch (e) { return s; }
}

function unb64(s){ var b = atob(s), u = new Uint8Array(b.length); for (var i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; }

var tws = null, tready = null, pending = new Map(), seq = 0, tunnelBad = false;
function wsBase(){ return (location.protocol === "https:" ? "wss://" : "ws://") + location.host; }

function openTunnel(){
  if (tws && (tws.readyState === 0 || tws.readyState === 1)) return tready;
  tready = new Promise(function(res, rej){
    tws = new _WS(wsBase() + "/tunnel");
    tws.onopen = function(){ res(); };
    tws.onerror = function(){ rej(new Error("tunnel error")); };
    tws.onclose = function(){
      pending.forEach(function(p){ p.fail(new Error("tunnel closed")); });
      pending.clear();
    };
    tws.onmessage = function(ev){
      var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      var p = pending.get(m.id); if (!p) return;
      if (m.type === "head") p.head(m);
      else if (m.type === "body") p.chunk(unb64(m.data));
      else if (m.type === "end") p.end();
      else if (m.type === "error") { var er = new TypeError(m.message || "Failed to fetch"); er.app = true; p.fail(er); }
    };
  });
  return tready;
}

function tunnelFetch(req, url){
  return openTunnel().then(function(){
    var id = ++seq;
    return new Promise(function(resolve, reject){
      var ctrl;
      var stream = new ReadableStream({ start: function(c){ ctrl = c; }, cancel: function(){ pending.delete(id); } });
      var headers = []; req.headers.forEach(function(v, k){ headers.push([k, v]); });
      pending.set(id, {
        head: function(m){
          (m.cookies || []).forEach(function(c){ if (!/;\s*httponly/i.test(c)) { try { document.cookie = c; } catch (e) {} } });
          var st = m.status;
          if (st < 200 || st > 599) st = 502;
          var nobody = [204, 205, 304].indexOf(st) >= 0 || req.method === "HEAD";
          resolve(new Response(nobody ? null : stream, { status: st, statusText: m.statusText, headers: m.headers }));
          if (nobody) pending.delete(id);
        },
        chunk: function(b){ try { ctrl.enqueue(b); } catch (e) {} },
        end: function(){ try { ctrl.close(); } catch (e) {} pending.delete(id); },
        fail: function(e){ try { ctrl.error(e); } catch (x) {} reject(e); pending.delete(id); }
      });
      if (req.signal) req.signal.addEventListener("abort", function(){
        pending.delete(id);
        try { ctrl.error(new DOMException("Aborted", "AbortError")); } catch (e) {}
        reject(new DOMException("Aborted", "AbortError"));
      });
      tws.send(JSON.stringify({ id: id, url: url, method: req.method, headers: headers, cookie: document.cookie, referer: location.href, body: null }));
    });
  });
}

window.fetch = function(input, init){
  var url, req;
  try {
    url = toProxy(input instanceof Request ? input.url : input);
    if (input instanceof Request) {
      var o = { method: input.method, headers: input.headers, credentials: input.credentials, cache: input.cache, redirect: input.redirect, signal: input.signal };
      var plain = input.method === "GET" || input.method === "HEAD";
      var p = plain ? Promise.resolve(null) : input.clone().arrayBuffer();
      return p.then(function(buf){
        if (buf) o.body = buf;
        var r = new Request(url, Object.assign(o, init || {}));
        return send(r, url);
      });
    }
    req = new Request(url, init);
  } catch (e) { return _fetch(input, init); }
  return send(req, url);
};
function send(req, url){
  var m = req.method.toUpperCase();
  if (cfg.tunnel && !tunnelBad && (m === "GET" || m === "HEAD")) {
    return tunnelFetch(req, url).catch(function(e){
      if (e && e.name === "AbortError") throw e;
      if (!(e && e.app)) tunnelBad = true;
      return _fetch(req);
    });
  }
  return _fetch(req);
}

XMLHttpRequest.prototype.open = function(method, u){
  var a = Array.prototype.slice.call(arguments); a[1] = toProxy(u);
  return _xhrOpen.apply(this, a);
};
if (navigator.sendBeacon) { var _sb = navigator.sendBeacon.bind(navigator); navigator.sendBeacon = function(u, d){ return _sb(toProxy(u), d); }; }
if (window.EventSource) {
  var _ES = window.EventSource;
  window.EventSource = function(u, o){ return new _ES(toProxy(u), o); };
  window.EventSource.prototype = _ES.prototype;
}

window.WebSocket = function(url, protocols){
  var abs = new URL(String(url), real());
  var p = wsBase() + "/ws?url=" + encodeURIComponent(abs.href);
  return protocols === undefined ? new _WS(p) : new _WS(p, protocols);
};
window.WebSocket.prototype = _WS.prototype;
["CONNECTING", "OPEN", "CLOSING", "CLOSED"].forEach(function(k){ window.WebSocket[k] = _WS[k]; });

var attrs = { href: 1, src: 1, action: 1, poster: 1 };
var _sa = Element.prototype.setAttribute;
Element.prototype.setAttribute = function(n, v){
  if (attrs[String(n).toLowerCase()] && typeof v === "string") v = toProxy(v);
  return _sa.call(this, n, v);
};
[[HTMLAnchorElement, "href"], [HTMLAreaElement, "href"], [HTMLLinkElement, "href"], [HTMLImageElement, "src"],
 [HTMLScriptElement, "src"], [HTMLIFrameElement, "src"], [HTMLMediaElement, "src"], [HTMLSourceElement, "src"],
 [HTMLEmbedElement, "src"], [HTMLFormElement, "action"], [HTMLInputElement, "src"]].forEach(function(pair){
  var d = Object.getOwnPropertyDescriptor(pair[0].prototype, pair[1]);
  if (!d || !d.set) return;
  Object.defineProperty(pair[0].prototype, pair[1], {
    get: d.get, set: function(v){ d.set.call(this, toProxy(v)); }, configurable: true, enumerable: d.enumerable
  });
});

["pushState", "replaceState"].forEach(function(k){
  var o = history[k];
  history[k] = function(s, t, u){
    var r = o.call(this, s, t, u == null ? u : toProxy(u));
    try { onNav(); } catch (e) {}
    return r;
  };
});
var _wo = window.open;
window.open = function(u){ var a = Array.prototype.slice.call(arguments); if (u) a[0] = toProxy(u); return _wo.apply(window, a); };
if (navigator.serviceWorker) {
  try { navigator.serviceWorker.register = function(){ return Promise.reject(new Error("Service workers disabled")); }; } catch (e) {}
}

/* ---------- cellar toolbar (top frame only) ---------- */
var DOCK_CSS = ${JSON.stringify(DOCK_CSS)};

function isApp(){
  try {
    if (window.top === window) return true;
    return window.parent === window.top && window.top.location.href === "about:blank";
  } catch (e) { return false; }
}

function dock(){
  var host = document.createElement("div");
  host.setAttribute("data-cellar", "");
  host.style.cssText = "all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647";
  var sh = host.attachShadow({ mode: "closed" });
  function I(d){ return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="' + d + '"/></svg>'; }
  sh.innerHTML =
    "<style>" + DOCK_CSS + "</style>" +
    '<div class="root" id="root">' +
    '<div class="tab" id="tab" title="cellar toolbar (Alt+C)"><i></i></div>' +
    '<div class="bar">' +
    '<button class="b" id="bk" style="--k:0" title="Back">' + I("M15 5l-7 7 7 7") + "</button>" +
    '<button class="b" id="fw" style="--k:1" title="Forward">' + I("M9 5l7 7-7 7") + "</button>" +
    '<button class="b" id="rl" style="--k:2" title="Reload">' + I("M20 12a8 8 0 1 1-2.5-5.8M20 4v5h-5") + "</button>" +
    '<button class="b" id="hm" style="--k:3" title="cellar home">' + I("M4 11l8-7 8 7v9h-5v-6H9v6H4z") + "</button>" +
    '<input id="ad" style="--k:4" spellcheck="false" autocomplete="off" autocapitalize="off" placeholder="search or enter address">' +
    '<button class="b" id="pn" style="--k:5" title="Pin this page">' + I("M12 4l2.5 5.2 5.7.8-4.1 4 1 5.7L12 17l-5.1 2.7 1-5.7-4.1-4 5.7-.8z") + "</button>" +
    '<button class="b" id="cl" style="--k:6" title="Hide (Esc)">' + I("M6 6l12 12M18 6L6 18") + "</button>" +
    "</div></div>";

  var root = sh.getElementById("root"), ad = sh.getElementById("ad"), pn = sh.getElementById("pn");
  var origTitle = document.title;

  function show(){ try { if (sh.activeElement !== ad) ad.value = real().href; pn.classList.toggle("on", CL.isPinned(real().href)); } catch (e) {} }
  function open(){ root.classList.add("open"); show(); ad.focus(); ad.select(); }
  function close(){ root.classList.remove("open"); ad.blur(); }

  sh.getElementById("tab").onclick = open;
  sh.getElementById("cl").onclick = close;
  sh.getElementById("bk").onclick = function(){ history.back(); };
  sh.getElementById("fw").onclick = function(){ history.forward(); };
  sh.getElementById("rl").onclick = function(){ location.reload(); };
  sh.getElementById("hm").onclick = function(){ location.href = "/cellar"; };
  pn.onclick = function(){ CL.togglePin(real().href, origTitle || real().hostname); show(); };

  ["keydown", "keyup", "keypress"].forEach(function(t){
    ad.addEventListener(t, function(e){
      e.stopPropagation();
      if (t === "keydown") {
        if (e.key === "Enter") { var v = ad.value.trim(); if (v) CL.go(v); }
        else if (e.key === "Escape") close();
      }
    });
  });

  window.addEventListener("keydown", function(e){
    if (e.altKey && e.code === "KeyC") { e.preventDefault(); root.classList.contains("open") ? close() : open(); }
    else if (e.key === "Escape" && root.classList.contains("open")) close();
  }, true);

  window.addEventListener("beforeunload", function(){
    root.classList.add("busy");
    setTimeout(function(){ root.classList.remove("busy"); }, 8000);
  });
  window.addEventListener("popstate", show);
  window.addEventListener("hashchange", show);
  onNav = show;

  document.documentElement.appendChild(host);
  window.addEventListener("load", function(){ if (!host.isConnected) document.documentElement.appendChild(host); });
  show();
}

function boot(){
  try {
    if (!isApp()) return;
    CL.addRecent(real().href, document.title);
    CL.armPanic();
    dock();
    CL.applyCloak();
  } catch (e) {}
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})`;

/* ============================== ERROR / LOCK PAGE STYLE ============================== */

const PAGE_CSS = String.raw`
*{box-sizing:border-box}
html,body{height:100%;margin:0}
body{display:grid;place-items:center;background:#050505;color:#eee;font:15px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;overflow:hidden}
body::before{content:"";position:fixed;inset:0;background:radial-gradient(ellipse at 50% 40%,#1b1b1b,#050505 70%);animation:fade 1.6s ease both}
main{position:relative;text-align:center;padding:24px;width:min(460px,92vw)}
main>*{animation:up .9s cubic-bezier(.2,.9,.2,1) backwards}
main>*:nth-child(2){animation-delay:.12s}
main>*:nth-child(3){animation-delay:.24s}
main>*:nth-child(4){animation-delay:.36s}
.code{font-size:clamp(72px,18vw,130px);font-weight:300;letter-spacing:.08em;color:#d8d8d8;line-height:1.1;animation:up .9s cubic-bezier(.2,.9,.2,1) backwards,flick 6s steps(1) 1.5s infinite}
h1{font-size:18px;font-weight:400;margin:8px 0 10px;letter-spacing:.04em}
p{color:#808080;margin:0 0 28px;line-height:1.6;font-size:13px;overflow-wrap:anywhere}
.btn{display:inline-block;margin-top:4px;padding:11px 24px;border-radius:999px;border:1px solid rgba(255,255,255,.25);background:transparent;color:#eee;text-decoration:none;font:inherit;cursor:pointer;transition:background .3s,color .3s,transform .4s cubic-bezier(.2,.9,.2,1)}
.btn:hover{background:#eee;color:#000;transform:translateY(-2px)}
form{display:flex;flex-direction:column;gap:14px;align-items:center;margin-top:22px}
input{width:100%;height:52px;padding:0 22px;border-radius:999px;border:1px solid rgba(255,255,255,.18);background:rgba(10,10,10,.8);color:#fff;font:inherit;letter-spacing:.04em;text-align:center;outline:none;transition:border-color .3s,box-shadow .4s}
input:focus{border-color:rgba(255,255,255,.55);box-shadow:0 0 50px rgba(255,255,255,.08)}
input.bad{animation:shake .45s ease;border-color:rgba(255,255,255,.6)}
@keyframes up{from{opacity:0;transform:translateY(14px);filter:blur(6px)}to{opacity:1;transform:none;filter:blur(0)}}
@keyframes fade{from{opacity:0}}
@keyframes flick{0%,92%,96%,100%{opacity:1}94%{opacity:.35}98%{opacity:.7}}
@keyframes shake{20%{transform:translateX(-9px)}40%{transform:translateX(8px)}60%{transform:translateX(-5px)}80%{transform:translateX(3px)}}
`;

/* ============================== CELLAR HOME PAGE ============================== */
/* String.raw: backslashes below are literal, so the page script reads normally.
   The background is a procedural night landscape painted straight into the full viewport (no image fetch). */

const HOME_HTML = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<title>cellar</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%23000'/%3E%3Ctext x='16' y='23' font-size='22' text-anchor='middle' fill='%23fff' font-family='monospace'%3Ec%3C/text%3E%3C/svg%3E">
<script>${SHARED_JS}
var CL=CELLAR(${JSON.stringify(CONFIG.ENGINES)});
(function(){var p=new URLSearchParams(location.search),v=p.get("q")||p.get("url");if(v){document.documentElement.style.visibility="hidden";CL.go(v,true)}})();
</script>
<style>
:root{--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;--ease:cubic-bezier(.2,.9,.2,1)}
@property --ang{syntax:"<angle>";inherits:false;initial-value:0deg}
*{box-sizing:border-box}
html,body{height:100%;margin:0}
body{background:#050505;color:#eee;font-family:var(--mono);overflow:hidden}
button{font-family:inherit}

#art{position:fixed;inset:0;width:100%;height:100%;display:block;animation:artIn 2.4s ease backwards}
@keyframes artIn{from{opacity:0}to{opacity:1}}
.vig{position:fixed;inset:0;z-index:1;pointer-events:none;background:radial-gradient(ellipse at 50% 42%,transparent 38%,rgba(0,0,0,.78) 100%)}
.grain{position:fixed;z-index:40;pointer-events:none;inset:-50%;width:200%;height:200%;opacity:.07;
  background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='200' height='200'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 1 0'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>");
  animation:grain 1s steps(6) infinite}
@keyframes grain{0%{transform:translate(0,0)}20%{transform:translate(-4%,3%)}40%{transform:translate(3%,-5%)}60%{transform:translate(-5%,-2%)}80%{transform:translate(4%,4%)}100%{transform:translate(0,0)}}

.hero{position:fixed;left:0;right:0;top:63%;transform:translateY(-50%);z-index:5;display:flex;flex-direction:column;align-items:center;padding:0 16px;
  transition:opacity .6s ease,filter .6s ease,transform .9s var(--ease)}
.hero::before{content:"";position:absolute;inset:-70px -10vw;z-index:-1;pointer-events:none;
  background:radial-gradient(closest-side,rgba(0,0,0,.74),rgba(0,0,0,.4) 60%,transparent)}
body.panel .hero{opacity:.3;filter:blur(3px)}

.title{margin:0 0 30px;padding-left:.06em;display:flex;font-weight:300;font-size:clamp(64px,13vw,150px);line-height:1;letter-spacing:.06em;user-select:none}
.title span{display:inline-block;color:#cfcfcf;opacity:0;
  animation:letterIn 1.2s var(--ease) calc(.5s + var(--i)*90ms) forwards,pulse 6s ease-in-out calc(2.8s + var(--i)*260ms) infinite;
  transition:translate .5s var(--ease)}
.title span:hover{translate:0 -10px}
@keyframes letterIn{from{opacity:0;filter:blur(20px);transform:translateY(28px) scale(1.18)}to{opacity:1;filter:blur(0);transform:none}}
@keyframes pulse{0%,60%,100%{color:#cfcfcf;text-shadow:0 0 0 rgba(255,255,255,0)}30%{color:#fff;text-shadow:0 0 32px rgba(255,255,255,.5)}}

.barwrap{position:relative;width:min(620px,90vw)}
.bar{--mx:50%;--my:50%;position:relative;display:flex;align-items:center;gap:12px;width:100%;height:58px;padding:0 8px 0 22px;border-radius:999px;
  background:radial-gradient(260px circle at var(--mx) var(--my),rgba(255,255,255,.08),transparent 65%),rgba(10,10,10,.72);
  -webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);
  box-shadow:0 24px 70px rgba(0,0,0,.65);
  transition:transform .6s var(--ease),box-shadow .5s ease;
  animation:barIn 1.2s var(--ease) 1.4s backwards}
@keyframes barIn{from{opacity:0;clip-path:inset(47% 50% 47% 50% round 999px)}60%{opacity:1}to{opacity:1;clip-path:inset(0 0 0 0 round 999px)}}
.bar>*{animation:fadeUp .7s ease 2.1s backwards}
@keyframes fadeUp{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.bar:focus-within{transform:scale(1.03);box-shadow:0 30px 90px rgba(0,0,0,.8),0 0 60px rgba(255,255,255,.06)}
.bar.shake{animation:shake .45s ease}
@keyframes shake{20%{transform:translateX(-9px)}40%{transform:translateX(8px)}60%{transform:translateX(-5px)}80%{transform:translateX(3px)}}

.bar::before,.bar::after{content:"";position:absolute;inset:0;border-radius:inherit;padding:1px;pointer-events:none;
  -webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;
  mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);mask-composite:exclude}
.bar::before{background:radial-gradient(200px circle at var(--mx) var(--my),rgba(255,255,255,.75),transparent 70%),linear-gradient(rgba(255,255,255,.13),rgba(255,255,255,.13))}
.bar::after{background:conic-gradient(from var(--ang),transparent 0 55%,rgba(255,255,255,.95) 80%,transparent 100%);opacity:0;transition:opacity .5s ease;animation:spin 3.5s linear infinite}
.bar:focus-within::after{opacity:1}
@keyframes spin{to{--ang:360deg}}

.mag{display:grid;place-items:center;color:#7d7d7d;transition:color .4s ease,transform .6s var(--ease)}
.bar:focus-within .mag{color:#fff;transform:scale(1.12) rotate(-10deg)}
#q{flex:1;min-width:0;height:100%;padding:0;border:0;outline:0;background:transparent;color:#f4f4f4;caret-color:#fff;font:17px var(--mono);letter-spacing:.02em}
.ph{position:absolute;left:56px;top:50%;transform:translateY(-50%);pointer-events:none;color:#6f6f6f;font:17px var(--mono);letter-spacing:.02em;white-space:nowrap;transition:opacity .25s ease}
.bar:not(:focus-within) .ph::after{content:"_";animation:blink 1s steps(1) infinite}
.bar:focus-within .ph{color:#585858}
.bar.has .ph{opacity:0}
@keyframes blink{50%{opacity:0}}

.eng{flex:none;height:28px;padding:0 11px;border:1px solid rgba(255,255,255,.16);border-radius:999px;background:transparent;color:#8a8a8a;font-size:11px;letter-spacing:.08em;text-transform:uppercase;cursor:pointer;overflow:hidden;
  transition:color .3s,border-color .3s,background .3s,transform .4s var(--ease)}
.eng:hover{color:#fff;border-color:rgba(255,255,255,.45);background:rgba(255,255,255,.06)}
.eng:active{transform:scale(.92)}
.eng span{display:block}
.eng span.flip{animation:flip .45s var(--ease)}
@keyframes flip{from{opacity:0;transform:translateY(100%)}to{opacity:1;transform:none}}

.go{flex:none;width:42px;height:42px;border:0;border-radius:50%;display:grid;place-items:center;cursor:pointer;background:#f2f2f2;color:#000;
  opacity:0;pointer-events:none;transform:scale(.4) rotate(-90deg);transition:transform .55s var(--ease),opacity .3s ease,background .2s ease;animation:none}
.bar.has .go{opacity:1;pointer-events:auto;transform:none}
.go svg{transition:transform .3s var(--ease)}
.go:hover{background:#fff}.go:hover svg{transform:translateX(3px)}
.bar.has .go:active{transform:scale(.9)}

.sug{list-style:none;margin:10px 0 0;padding:6px;position:absolute;left:0;right:0;top:100%;z-index:6;border-radius:22px;
  background:rgba(10,10,10,.84);-webkit-backdrop-filter:blur(18px);backdrop-filter:blur(18px);border:1px solid rgba(255,255,255,.12);box-shadow:0 24px 60px rgba(0,0,0,.6);display:none;transform-origin:top center}
.sug.on{display:block;animation:sugIn .4s var(--ease)}
@keyframes sugIn{from{opacity:0;transform:translateY(-8px) scale(.98)}}
.sug li{padding:11px 16px;border-radius:16px;color:#aaa;cursor:pointer;font-size:15px;display:flex;gap:12px;align-items:center;
  animation:fadeUp .45s var(--ease) calc(var(--k)*40ms) backwards;transition:background .25s,color .25s,padding-left .35s var(--ease)}
.sug li svg{flex:none;opacity:.45}
.sug li.sel,.sug li:hover{background:rgba(255,255,255,.09);color:#fff;padding-left:22px}

.chips{position:absolute;left:0;right:0;top:100%;margin-top:24px;display:flex;flex-wrap:wrap;justify-content:center;gap:8px;transition:opacity .4s ease,transform .5s var(--ease)}
.chips.hide{opacity:0;pointer-events:none;transform:translateY(-6px)}
.chip{display:flex;align-items:center;gap:8px;height:34px;padding:0 8px 0 6px;border-radius:999px;background:rgba(10,10,10,.62);-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);
  border:1px solid rgba(255,255,255,.12);color:#9a9a9a;font-size:12.5px;cursor:pointer;
  animation:chipIn .7s var(--ease) calc(var(--k)*60ms) backwards;transition:color .3s,border-color .3s,transform .45s var(--ease),background .3s}
.chips.first .chip{animation-delay:calc(2.4s + var(--k)*70ms)}
@keyframes chipIn{from{opacity:0;transform:translateY(12px) scale(.9)}}
.chip:hover{color:#fff;border-color:rgba(255,255,255,.35);transform:translateY(-3px);background:rgba(20,20,20,.8)}
.chip b{flex:none;width:22px;height:22px;border-radius:50%;display:grid;place-items:center;background:#8c8c8c;color:#000;font-size:11px;text-transform:uppercase}
.chip.pin b{background:#fff;box-shadow:0 0 14px rgba(255,255,255,.45)}
.chip .t{max-width:15ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chip .rm{width:18px;height:18px;border:0;border-radius:50%;background:transparent;color:#666;cursor:pointer;font-size:14px;line-height:1;display:grid;place-items:center;transition:background .25s,color .25s}
.chip .rm:hover{background:rgba(255,255,255,.18);color:#fff}

.back{position:fixed;top:18px;left:18px;z-index:12;height:42px;padding:0 16px;display:flex;align-items:center;border-radius:999px;border:1px solid rgba(255,255,255,.14);background:rgba(10,10,10,.6);-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);color:#9a9a9a;font:12px var(--mono);letter-spacing:.1em;text-decoration:none;
  animation:fadeUp .9s var(--ease) 2.6s backwards;transition:color .3s,border-color .3s,transform .5s var(--ease),opacity .5s}
.back:hover{color:#fff;border-color:rgba(255,255,255,.4);transform:translateX(-3px)}

.gear{position:fixed;top:18px;right:18px;z-index:12;width:42px;height:42px;border-radius:50%;border:1px solid rgba(255,255,255,.14);background:rgba(10,10,10,.6);-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);color:#9a9a9a;display:grid;place-items:center;cursor:pointer;
  animation:fadeUp .9s var(--ease) 2.6s backwards;transition:color .3s,border-color .3s,transform .6s var(--ease),opacity .5s}
.gear:hover{color:#fff;border-color:rgba(255,255,255,.4);transform:rotate(90deg)}

.scrim{position:fixed;inset:0;z-index:28;background:rgba(0,0,0,.45);opacity:0;pointer-events:none;transition:opacity .5s ease}
.scrim.on{opacity:1;pointer-events:auto}
.panel{position:fixed;top:0;right:0;bottom:0;z-index:30;width:min(370px,100vw);padding:26px 24px 30px;overflow:auto;
  background:rgba(8,8,8,.9);-webkit-backdrop-filter:blur(22px);backdrop-filter:blur(22px);border-left:1px solid rgba(255,255,255,.12);
  transform:translateX(104%);transition:transform .7s var(--ease),opacity .5s}
.panel.on{transform:none}
.panel.on .sec{animation:fadeUp .65s var(--ease) calc(.18s + var(--k)*60ms) backwards}
.sec{margin-bottom:26px}
.sec.head{display:flex;justify-content:space-between;align-items:center}
.panel h2{margin:0;font-size:20px;font-weight:300;letter-spacing:.1em}
.panel label{display:block;margin-bottom:10px;color:#777;font-size:11px;letter-spacing:.16em;text-transform:uppercase}
.panel small{display:block;margin-top:10px;color:#666;font-size:12px;line-height:1.55}
.x{width:34px;height:34px;border-radius:50%;border:1px solid rgba(255,255,255,.14);background:transparent;color:#aaa;font-size:18px;cursor:pointer;transition:background .3s,color .3s,transform .5s var(--ease)}
.x:hover{background:#eee;color:#000;transform:rotate(90deg)}
.seg{display:flex;flex-wrap:wrap;gap:6px}
.seg button{padding:8px 14px;border-radius:999px;border:1px solid rgba(255,255,255,.16);background:transparent;color:#999;font-size:12.5px;cursor:pointer;transition:background .3s,color .3s,border-color .3s,transform .4s var(--ease)}
.seg button:hover{color:#fff;border-color:rgba(255,255,255,.4);transform:translateY(-2px)}
.seg button.on{background:#eee;color:#000;border-color:#eee}
.panel input{width:100%;height:42px;padding:0 16px;border-radius:12px;border:1px solid rgba(255,255,255,.16);background:rgba(255,255,255,.04);color:#eee;font:13px var(--mono);outline:none;transition:border-color .3s,background .3s}
.panel input:focus{border-color:rgba(255,255,255,.5);background:rgba(255,255,255,.07)}
.act{width:100%;height:42px;border-radius:12px;border:1px solid rgba(255,255,255,.16);background:transparent;color:#ccc;font-size:13px;cursor:pointer;transition:background .3s,color .3s,transform .4s var(--ease)}
.act:hover{background:#eee;color:#000;transform:translateY(-2px)}
.keys{color:#666;font-size:12px;line-height:2}
kbd{display:inline-block;min-width:22px;padding:1px 7px;border-radius:6px;border:1px solid rgba(255,255,255,.2);color:#bbb;font:11px var(--mono);text-align:center}

.toast{position:fixed;left:50%;bottom:34px;z-index:45;transform:translate(-50%,24px);padding:11px 20px;border-radius:999px;background:rgba(240,240,240,.95);color:#000;font-size:13px;opacity:0;pointer-events:none;transition:opacity .4s ease,transform .6s var(--ease)}
.toast.on{opacity:1;transform:translate(-50%,0)}

.veil{position:fixed;inset:0;z-index:50;background:#000;pointer-events:none;clip-path:circle(0 at var(--vx,50%) var(--vy,60%))}
body.leaving .veil{clip-path:circle(150vmax at var(--vx,50%) var(--vy,60%));transition:clip-path .85s cubic-bezier(.7,0,.3,1) .1s}
body.leaving .hero{opacity:0;filter:blur(10px);transform:translateY(-50%) scale(1.07)}
body.leaving .gear,body.leaving .panel,body.leaving .back{opacity:0}

@media (max-width:480px){.eng{display:none}}
@media (prefers-reduced-motion:reduce){
  *,*::before,*::after{animation-duration:.01ms!important;animation-delay:0s!important;animation-iteration-count:1!important;transition-duration:.01ms!important}
}
</style></head>
<body>
<canvas id="art" aria-hidden="true"></canvas>
<div class="vig"></div>

<a class="back" id="back" href="/">&larr; back</a>
<button class="gear" id="gear" aria-label="Settings"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="16" cy="7" r="2"/><circle cx="8" cy="12" r="2"/><circle cx="14" cy="17" r="2"/><path d="M4 7h10M18 7h2M4 12h2M10 12h10M4 17h8M16 17h4"/></svg></button>

<main class="hero" id="hero">
  <h1 class="title" id="title" aria-label="cellar"></h1>
  <div class="barwrap" id="bw">
    <form class="bar" id="f" autocomplete="off">
      <span class="mag" aria-hidden="true"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg></span>
      <input id="q" type="text" spellcheck="false" autocapitalize="off" autocorrect="off" aria-label="Search or enter address">
      <span class="ph" id="ph" aria-hidden="true"></span>
      <button class="eng" id="eng" type="button" title="Switch search engine"><span id="engn"></span></button>
      <button class="go" type="submit" aria-label="Go"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg></button>
    </form>
    <ul class="sug" id="sug" role="listbox"></ul>
    <div class="chips first" id="chips"></div>
  </div>
</main>

<div class="scrim" id="scrim"></div>
<aside class="panel" id="panel" aria-hidden="true">
  <div class="sec head" style="--k:0"><h2>settings</h2><button class="x" id="px" aria-label="Close">&times;</button></div>
  <div class="sec" style="--k:1"><label>search engine</label><div class="seg" id="sEng"></div></div>
  <div class="sec" style="--k:2"><label>background</label><div class="seg" id="sArt"></div></div>
  <div class="sec" style="--k:3"><label>tab disguise</label><div class="seg" id="sCloak"></div></div>
  <div class="sec" style="--k:4"><label>panic link</label><input id="sPanic" spellcheck="false" autocomplete="off" placeholder="https://docs.google.com/"><small>press <kbd>&#96;</kbd> twice, anywhere, to jump there instantly. leave empty to disable.</small></div>
  <div class="sec" style="--k:5"><label>cloak</label><button class="act" id="sLaunch" type="button">launch in about:blank</button><small>opens cellar inside a blank tab and sends this tab to your panic link.</small></div>
  <div class="sec" style="--k:6"><label>data</label><button class="act" id="sClear" type="button">clear recents &amp; pins</button></div>
  <div class="sec keys" style="--k:7"><kbd>/</kbd> focus search
<kbd>&uarr;</kbd><kbd>&darr;</kbd> pick a suggestion
<kbd>esc</kbd> close
<kbd>alt</kbd>+<kbd>c</kbd> toolbar on any page</div>
</aside>
<div class="toast" id="toast"></div>

<div class="veil" id="veil"></div>
<div class="grain"></div>

<script>
(function(){
"use strict";
var RAMP=" .:-=+*#%@";
var NOISE="/\\|<>[]{}()01xo?&;^~";
var ALL=RAMP+NOISE;
var ANCHOR=0.3;
var reduce=window.matchMedia("(prefers-reduced-motion: reduce)").matches;
var S0=CL.load();

var cv=document.getElementById("art"),ctx=cv.getContext("2d");
var hero=document.getElementById("hero"),bar=document.getElementById("f"),q=document.getElementById("q");
var W,H,dpr,fs,cw,ch,cols,rows,gw,gh,atlas,lum,mask,dist,noise,motes=[];
var mx=-999,my=-999,smx=-999,smy=-999;
var ripples=[],gA=0.6,gTarget=0.6;
var t0=performance.now(),last=0,started=false;
var artMode=S0.art,artKT=artMode==="off"?0:artMode==="dim"?.4:1,artK=artKT,cleared=false;

function rng(a){return function(){a|=0;a=a+0x6D2B79F5|0;var t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}
function hash(a,b){var h=Math.imul(a^Math.imul(b,0x9E3779B1),0x85EBCA6B);h^=h>>>13;h=Math.imul(h,0xC2B2AE35);h^=h>>>16;return h>>>0}
function clamp(v,a,b){return v<a?a:v>b?b:v}
function smooth(a,b,x){x=clamp((x-a)/(b-a),0,1);return x*x*(3-2*x)}

/* ---------- the painting: a night landscape (moon, stars, ridges, lake, pines), grayscale, drawn to fill the whole canvas ---------- */
function paintLandscape(g,W,H,cw){
  var R=rng(23),i,x,y;
  function gr(v){v=clamp(v,0,1);var n=Math.round(v*255);return "rgb("+n+","+n+","+n+")"}
  var hz=H*.62,wl=H*.77,mx0=W*.5,my0=H*.3,mr=Math.max(Math.min(W,H*1.8)*.06,16),rowH=Math.max(2,H*.007);

  var sk=g.createLinearGradient(0,0,0,hz);
  sk.addColorStop(0,gr(.02));sk.addColorStop(.55,gr(.13));sk.addColorStop(1,gr(.36));
  g.fillStyle=sk;g.fillRect(0,0,W,H);

  var hg=g.createRadialGradient(mx0,my0,mr*.6,mx0,my0,mr*7);
  hg.addColorStop(0,"rgba(255,255,255,.5)");hg.addColorStop(.35,"rgba(255,255,255,.16)");hg.addColorStop(1,"rgba(255,255,255,0)");
  g.fillStyle=hg;g.fillRect(0,0,W,H);

  var ns=Math.round(W*H/4500);
  for(i=0;i<ns;i++){
    x=R()*W;y=R()*hz*.9;
    var dd=Math.sqrt((x-mx0)*(x-mx0)+(y-my0)*(y-my0));
    if(dd<mr*2.4)continue;
    var sz=cw*(.35+R()*.55);
    g.fillStyle=gr(.3+R()*.7);g.fillRect(x,y,sz,sz*1.3);
  }

  g.fillStyle=gr(.98);g.beginPath();g.arc(mx0,my0,mr,0,7);g.fill();
  g.fillStyle=gr(.78);
  [[-.35,-.25,.22],[.3,.1,.28],[-.1,.4,.18],[.1,-.45,.14],[-.45,.2,.12]].forEach(function(c){
    g.beginPath();g.arc(mx0+c[0]*mr,my0+c[1]*mr,c[2]*mr,0,7);g.fill();
  });

  for(i=0;i<9;i++){
    var cx=R()*W,cy=H*(.12+R()*.34),crx=W*(.05+R()*.12),cry=H*(.008+R()*.014),a=.07+R()*.16;
    g.fillStyle="rgba(255,255,255,"+a.toFixed(3)+")";
    g.beginPath();g.ellipse(cx,cy,crx,cry,0,0,7);g.fill();
    g.beginPath();g.ellipse(cx+crx*.3,cy-cry*.7,crx*.55,cry*.9,0,0,7);g.fill();
  }

  function ridge(base,amp,seed,top,bot,f,hl){
    var rr=rng(seed),p0=rr()*6.28,p1=rr()*6.28,p2=rr()*6.28,p3=rr()*6.28,n=Math.ceil(W/5),k,u,v,pts=[];
    for(k=0;k<=n;k++){
      u=k/n*6.2832*f;
      v=.5*(1-Math.abs(Math.sin(u+p0)))+.28*(1-Math.abs(Math.sin(u*2.3+p1)))+.15*(1-Math.abs(Math.sin(u*5.1+p2)))+.07*Math.sin(u*11+p3);
      pts.push([k/n*W,base-amp*v]);
    }
    g.beginPath();g.moveTo(0,H);
    for(k=0;k<pts.length;k++)g.lineTo(pts[k][0],pts[k][1]);
    g.lineTo(W,H);g.closePath();
    var lg=g.createLinearGradient(0,base-amp,0,base+amp*.4);
    lg.addColorStop(0,gr(top));lg.addColorStop(1,gr(bot));
    g.fillStyle=lg;g.fill();
    g.beginPath();
    for(k=0;k<pts.length;k++){if(k)g.lineTo(pts[k][0],pts[k][1]);else g.moveTo(pts[k][0],pts[k][1])}
    g.lineWidth=Math.max(1,cw*.35);g.lineJoin="round";g.strokeStyle=gr(hl);g.stroke();
  }
  ridge(hz,H*.22,3,.34,.14,1.1,.7);
  ridge(hz+H*.03,H*.16,7,.22,.09,1.7,.52);
  ridge(hz+H*.07,H*.1,11,.12,.05,2.6,.36);

  var wg=g.createLinearGradient(0,wl,0,H);wg.addColorStop(0,gr(.2));wg.addColorStop(1,gr(.04));
  g.fillStyle=wg;g.fillRect(0,wl,W,H-wl);
  g.fillStyle=gr(.5);g.fillRect(0,wl,W,Math.max(1,cw*.3));
  for(y=wl+rowH;y<H;y+=rowH){
    var tt=(y-wl)/(H-wl),wd=mr*(.45+1.8*tt),jx=(R()-.5)*wd*.9*tt;
    g.fillStyle=gr((.85-.55*tt)*(.45+R()*.55));
    g.fillRect(mx0-wd/2+jx,y,wd*(.35+R()*.65),rowH*.7);
  }
  for(i=0;i<140;i++){
    y=wl+R()*(H-wl);x=R()*W;
    g.fillStyle=gr(.1+R()*.14);g.fillRect(x,y,W*(.02+R()*.08),rowH*.5);
  }

  g.fillStyle=gr(.015);
  g.beginPath();g.moveTo(0,H);g.lineTo(0,H*.84);g.quadraticCurveTo(W*.14,H*.8,W*.3,H*.9);g.lineTo(W*.36,H);g.closePath();g.fill();
  g.beginPath();g.moveTo(W,H);g.lineTo(W,H*.82);g.quadraticCurveTo(W*.86,H*.79,W*.7,H*.9);g.lineTo(W*.62,H);g.closePath();g.fill();

  function pine(px,by,h,w){
    var k;
    for(k=0;k<6;k++){
      var ty=by-h+k*h*.15,bw=w*(.3+k*.14),bh=h*.3;
      g.beginPath();g.moveTo(px,ty);g.lineTo(px+bw,ty+bh);g.lineTo(px-bw,ty+bh);g.closePath();
      g.fillStyle=gr(.012);g.fill();
      g.lineWidth=Math.max(1,cw*.25);g.strokeStyle=gr(.2);g.stroke();
    }
    g.fillStyle=gr(.012);g.fillRect(px-w*.05,by-h*.05,w*.1,h*.12);
  }
  var np=Math.max(6,Math.round(W/70));
  for(i=0;i<np;i++){
    var left=i%2===0;
    x=left?R()*W*.3:W-R()*W*.3;
    pine(x,H*(.82+R()*.14),H*(.12+R()*.24),H*(.03+R()*.03));
  }
}

/* ---------- layout: sample the picture into a character grid ---------- */
function layout(){
  W=window.innerWidth;H=window.innerHeight;dpr=Math.min(window.devicePixelRatio||1,2);
  fs=Math.max(9,Math.min(15,W/135));cw=fs*.6;ch=fs;
  cols=Math.ceil(W/cw);rows=Math.ceil(H/ch);
  cv.width=Math.round(W*dpr);cv.height=Math.round(H*dpr);

  gw=Math.ceil(cw*dpr);gh=Math.ceil(ch*dpr);
  atlas=document.createElement("canvas");atlas.width=gw*ALL.length;atlas.height=gh;
  var a=atlas.getContext("2d");
  a.fillStyle="#fff";a.font="600 "+(fs*dpr)+"px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";
  a.textAlign="center";a.textBaseline="middle";
  for(var i=1;i<ALL.length;i++)a.fillText(ALL.charAt(i),i*gw+gw/2,gh/2+dpr*.5);

  var S=3,aw=cols*S,ah=rows*S;
  var oc=document.createElement("canvas");oc.width=aw;oc.height=ah;
  var g=oc.getContext("2d",{willReadFrequently:true});
  g.fillStyle="#000";g.fillRect(0,0,aw,ah);
  g.setTransform(S/cw,0,0,S/ch,0,0);
  paintLandscape(g,cols*cw,rows*ch,cw);
  var d=g.getImageData(0,0,aw,ah).data;

  var n=cols*rows;
  lum=new Float32Array(n);mask=new Float32Array(n);dist=new Float32Array(n);noise=new Float32Array(n);
  var hx=(W/2)/cw,hy=(H*ANCHOR)/ch,rect=hero.getBoundingClientRect();
  var rx=rect.left+rect.width/2,ry=rect.top+rect.height/2;
  var ea=Math.min(rect.width,W)*.55+60,eb=rect.height*.62+30;
  var nr=rng(5),r,c,j,k,sum;
  for(r=0;r<rows;r++)for(c=0;c<cols;c++){
    i=r*cols+c;sum=0;
    for(j=0;j<S;j++)for(k=0;k<S;k++)sum+=d[((r*S+j)*aw+c*S+k)*4];
    lum[i]=Math.min(1,Math.pow(sum/(S*S*255),.85)*1.2);
    var px=(c+.5)*cw,py=(r+.5)*ch,e=Math.sqrt(Math.pow((px-rx)/ea,2)+Math.pow((py-ry)/eb,2));
    mask[i]=.1+.9*smooth(.7,1.5,e);
    var dx=c+.5-hx,dy=(r+.5-hy)*ch/cw;
    dist[i]=Math.sqrt(dx*dx+dy*dy);
    noise[i]=nr();
  }
  motes=[];
  for(i=0;i<46;i++)motes.push({x:nr()*cols,y:nr()*rows,sp:.6+nr()*1.6,ph:nr()*6.28,g:nr()<.6?1:2});
}

/* ---------- render ---------- */
function draw(t){
  var r,c,i,k;
  artK+=(artKT-artK)*.12;
  ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.clearRect(0,0,W,H);
  smx+=(mx-smx)*.2;smy+=(my-smy)*.2;
  gA+=(gTarget-gA)*.06;
  var R0=(t-.15)*95;
  var sweep=(t*16)%(cols*.6+rows+80)-40;
  var pulse=.55+.45*Math.sin(t*2.2);
  var ringR=(t*11)%46,ringA=(1-ringR/46)*.3;
  var flick=Math.floor(t*7),dec=Math.floor(t*16);
  var L1=RAMP.length-1,NL=NOISE.length;
  for(k=ripples.length-1;k>=0;k--)if(t-ripples[k].t>1.8)ripples.splice(k,1);

  for(r=0;r<rows;r++){
    for(c=0;c<cols;c++){
      i=r*cols+c;
      var d=dist[i],rv=R0-d-noise[i]*14;
      if(rv<0)continue;
      var idx,alpha,m=mask[i];
      var ddx=c-smx,ddy=(r-smy)*1.67,dm2=ddx*ddx+ddy*ddy;
      var fl=dm2<700?Math.exp(-dm2/150):0;
      m=m+(1-m)*fl*.7;
      if(rv<16){
        idx=RAMP.length+(hash(i,dec)%NL);
        alpha=(rv/16)*.85*(.3+.7*m);
      }else{
        var base=lum[i]*m,v=base;
        v*=.8+.2*Math.sin(t*.9+c*.045+r*.09);
        var sd=(c*.6+r)-sweep;
        if(sd<20&&sd>-20)v+=base*Math.exp(-sd*sd/64)*.6;
        v*=1+fl*1.1;
        if(d<22)v+=Math.exp(-d*d/30)*pulse*.95;
        var rd=d-ringR;
        if(rd<6&&rd>-6)v+=Math.exp(-rd*rd/3)*ringA;
        for(k=0;k<ripples.length;k++){
          var age=t-ripples[k].t,rr=d-age*70;
          if(rr<6&&rr>-6)v+=Math.exp(-rr*rr/4)*ripples[k].a*(1-age/1.8);
        }
        if(v<.04)continue;
        v=v>1?1:v;
        idx=(v*L1)|0;
        if((hash(i,flick)&63)===0)idx+=(hash(i,flick+9)&1)?1:-1;
        if(idx>L1)idx=L1;
        if(idx<=0)continue;
        alpha=Math.min(1,.3+v*.85)*gA;
      }
      ctx.globalAlpha=alpha*artK;
      ctx.drawImage(atlas,idx*gw,0,gw,gh,c*cw,r*ch,cw,ch);
    }
  }
  if(t>1.6){
    for(k=0;k<motes.length;k++){
      var p=motes[k];
      var y=((p.y-t*p.sp)%rows+rows)%rows,x=p.x+Math.sin(t*.5+p.ph)*3;
      ctx.globalAlpha=(.15+.35*(.5+.5*Math.sin(t*1.7+p.ph)))*Math.min(1,(t-1.6))*artK;
      ctx.drawImage(atlas,p.g*gw,0,gw,gh,x*cw,y*ch,cw,ch);
    }
  }
  ctx.globalAlpha=1;
}
function frame(now){
  requestAnimationFrame(frame);
  if(document.hidden)return;
  if(now-last<32)return;
  last=now;
  if(artMode==="off"&&artK<.005){
    if(!cleared){ctx.setTransform(1,0,0,1,0,0);ctx.clearRect(0,0,cv.width,cv.height);cleared=true}
    return;
  }
  draw((now-t0)/1000);
}
function ripple(a){ripples.push({t:(performance.now()-t0)/1000,a:a});if(ripples.length>6)ripples.shift()}
function setArt(m){
  artMode=m;artKT=m==="off"?0:m==="dim"?.4:1;cleared=false;
  if(reduce&&started){artK=artKT;draw(100)}
}

/* ---------- title: scramble into place ---------- */
var word="cellar",title=document.getElementById("title"),spans=[];
for(var k=0;k<word.length;k++){
  var sp=document.createElement("span");sp.textContent=word.charAt(k);sp.style.setProperty("--i",k);sp.setAttribute("aria-hidden","true");
  title.appendChild(sp);spans.push(sp);
}
if(!reduce){
  var GL="#@%&01/\\|<>*+=";
  spans.forEach(function(s,k){
    var a=520+k*90,b=a+800+k*40,fin=word.charAt(k);
    s.textContent=GL.charAt((Math.random()*GL.length)|0);
    setTimeout(function(){
      var st=performance.now();
      var iv=setInterval(function(){
        if(performance.now()-st>=b-a){clearInterval(iv);s.textContent=fin}
        else s.textContent=GL.charAt((Math.random()*GL.length)|0);
      },55);
    },a);
  });
}

/* ---------- typewriter placeholder ---------- */
var hints=["search the web","paste a link","example.com","what is a root cellar"],hi=0,ci=0,del=false,ph=document.getElementById("ph");
function tick(){
  if(q.value){ph.textContent="";return setTimeout(tick,300)}
  var h=hints[hi];
  if(!del){
    ci++;ph.textContent=h.slice(0,ci);
    if(ci===h.length){del=true;return setTimeout(tick,1800)}
    return setTimeout(tick,60+Math.random()*50);
  }
  ci--;ph.textContent=h.slice(0,ci);
  if(ci===0){del=false;hi=(hi+1)%hints.length;return setTimeout(tick,350)}
  return setTimeout(tick,28);
}
setTimeout(tick,reduce?0:2400);

/* ---------- toast ---------- */
var toastEl=document.getElementById("toast"),toastT=0;
function toast(msg){
  toastEl.textContent=msg;toastEl.classList.add("on");
  clearTimeout(toastT);toastT=setTimeout(function(){toastEl.classList.remove("on")},2200);
}

/* ---------- leave transition ---------- */
var leaving=false;
function leave(dest){
  if(leaving)return;leaving=true;
  var b=bar.getBoundingClientRect();
  document.body.style.setProperty("--vx",(b.left+b.width/2)+"px");
  document.body.style.setProperty("--vy",(b.top+b.height/2)+"px");
  gTarget=1;ripple(.9);setTimeout(function(){ripple(.7)},160);setTimeout(function(){ripple(.5)},320);
  document.body.classList.add("leaving");
  setTimeout(function(){location.href=dest},reduce?0:850);
}
function submitQuery(v){
  v=(v||"").trim();
  if(!v){
    bar.classList.remove("shake");void bar.offsetWidth;bar.classList.add("shake");
    setTimeout(function(){bar.classList.remove("shake")},500);
    return;
  }
  leave(CL.dest(CL.norm(v)));
}

/* ---------- search engine pill ---------- */
var engBtn=document.getElementById("eng"),engN=document.getElementById("engn");
function engIndex(){
  var id=CL.load().engine;
  for(var i=0;i<CL.engines.length;i++)if(CL.engines[i].id===id)return i;
  return 0;
}
function renderEng(animate){
  engN.textContent=CL.engines[engIndex()].name;
  if(animate){engN.classList.remove("flip");void engN.offsetWidth;engN.classList.add("flip")}
}
renderEng(false);
engBtn.addEventListener("click",function(){
  var n=(engIndex()+1)%CL.engines.length;
  CL.set("engine",CL.engines[n].id);
  renderEng(true);syncEngSeg();ripple(.4);
});

/* ---------- suggestions ---------- */
var sug=document.getElementById("sug"),chips=document.getElementById("chips");
var sugData=[],sel=-1,sugTimer=0,sugSeq=0;
var SEARCH_SVG='<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>';
function looksUrl(v){return /^https?:\/\//i.test(v)||/^[^\s\/]+\.[^\s\/]{2,}(\/.*)?$/.test(v)}
function closeSug(){sug.classList.remove("on");sugData=[];sel=-1;chips.classList.remove("hide")}
function markSel(){
  for(var i=0;i<sug.children.length;i++)sug.children[i].classList.toggle("sel",i===sel);
}
function showSug(list){
  if(!list.length)return closeSug();
  sug.innerHTML="";sugData=list;sel=-1;
  list.forEach(function(s,k){
    var li=document.createElement("li");
    li.style.setProperty("--k",k);
    li.innerHTML=SEARCH_SVG;
    li.appendChild(document.createTextNode(s));
    li.addEventListener("pointerdown",function(e){e.preventDefault();q.value=s;submitQuery(s)});
    sug.appendChild(li);
  });
  sug.classList.remove("on");void sug.offsetWidth;sug.classList.add("on");
  chips.classList.add("hide");
}
function fetchSug(v){
  var id=++sugSeq;
  fetch("/suggest?q="+encodeURIComponent(v)).then(function(r){return r.json()}).then(function(l){
    if(id===sugSeq&&q.value.trim()===v&&document.activeElement===q)showSug(l);
  }).catch(function(){});
}
q.addEventListener("input",function(){
  var v=q.value.trim();
  bar.classList.toggle("has",!!v);ripple(.5);
  clearTimeout(sugTimer);
  if(!v||looksUrl(v)){sugSeq++;closeSug();return}
  sugTimer=setTimeout(function(){fetchSug(v)},140);
});
q.addEventListener("keydown",function(e){
  if(!sugData.length)return;
  if(e.key==="ArrowDown"){e.preventDefault();sel=sel+1>=sugData.length?-1:sel+1;markSel()}
  else if(e.key==="ArrowUp"){e.preventDefault();sel=sel-1<-1?sugData.length-1:sel-1;markSel()}
  else if(e.key==="Enter"&&sel>=0){e.preventDefault();q.value=sugData[sel];submitQuery(sugData[sel])}
});
q.addEventListener("blur",function(){setTimeout(closeSug,120);gTarget=.6});
q.addEventListener("focus",function(){gTarget=.8;ripple(.35)});
bar.addEventListener("submit",function(e){e.preventDefault();submitQuery(q.value)});

/* ---------- recents + pins ---------- */
function hostOf(h){try{return new URL(h).hostname.replace(/^www\./,"")}catch(e){return h}}
function renderChips(){
  var s=CL.load(),items=[];
  s.pins.forEach(function(p){items.push({pin:true,h:p.h,o:p.h})});
  s.recents.forEach(function(r){
    var pinned=s.pins.some(function(p){try{return new URL(p.h).origin===r.o}catch(e){return false}});
    if(!pinned)items.push({pin:false,h:r.h,o:r.o});
  });
  chips.innerHTML="";
  items.slice(0,8).forEach(function(it,k){
    var host=hostOf(it.h);
    var el=document.createElement("div");el.className="chip"+(it.pin?" pin":"");el.style.setProperty("--k",k);
    el.title=it.h;
    var b=document.createElement("b");b.textContent=host.charAt(0)||"?";
    var t=document.createElement("span");t.className="t";t.textContent=host;
    var x=document.createElement("button");x.className="rm";x.type="button";x.textContent="\u00d7";x.title=it.pin?"Unpin":"Remove";
    x.addEventListener("click",function(e){e.stopPropagation();if(it.pin)CL.unpin(it.h);else CL.unrecent(it.o);renderChips()});
    el.addEventListener("click",function(){leave(CL.dest(it.h))});
    el.appendChild(b);el.appendChild(t);el.appendChild(x);
    chips.appendChild(el);
  });
}
renderChips();
setTimeout(function(){chips.classList.remove("first")},5000);

/* ---------- settings panel ---------- */
var panel=document.getElementById("panel"),scrim=document.getElementById("scrim");
function openPanel(){panel.classList.add("on");scrim.classList.add("on");document.body.classList.add("panel");panel.setAttribute("aria-hidden","false");ripple(.5)}
function closePanel(){panel.classList.remove("on");scrim.classList.remove("on");document.body.classList.remove("panel");panel.setAttribute("aria-hidden","true")}
document.getElementById("gear").addEventListener("click",openPanel);
document.getElementById("px").addEventListener("click",closePanel);
scrim.addEventListener("click",closePanel);

function seg(el,items,current,onPick){
  el.innerHTML="";
  items.forEach(function(it){
    var b=document.createElement("button");b.type="button";b.textContent=it.name;
    if(it.id===current)b.className="on";
    b.addEventListener("click",function(){
      for(var i=0;i<el.children.length;i++)el.children[i].classList.remove("on");
      b.classList.add("on");onPick(it.id);
    });
    el.appendChild(b);
  });
}
var sEng=document.getElementById("sEng");
function syncEngSeg(){
  var id=CL.load().engine;
  for(var i=0;i<sEng.children.length;i++)sEng.children[i].classList.toggle("on",CL.engines[i].id===id);
}
seg(sEng,CL.engines,S0.engine,function(id){CL.set("engine",id);renderEng(true)});
seg(document.getElementById("sArt"),[{id:"full",name:"full"},{id:"dim",name:"dim"},{id:"off",name:"off"}],S0.art,function(id){CL.set("art",id);setArt(id)});
seg(document.getElementById("sCloak"),Object.keys(CL.CLOAKS).map(function(k){return {id:k,name:CL.CLOAKS[k].name}}),S0.cloak,function(id){CL.set("cloak",id);CL.applyCloak()});

var sPanic=document.getElementById("sPanic");
sPanic.value=S0.panic;
sPanic.addEventListener("input",function(){
  var v=sPanic.value.trim();
  if(v&&!/^https?:\/\//i.test(v))v="https://"+v;
  CL.set("panic",v);
});
document.getElementById("sLaunch").addEventListener("click",function(){
  if(!CL.launch())toast("popup blocked - allow popups and try again");
});
document.getElementById("sClear").addEventListener("click",function(){CL.clearData();renderChips();toast("cleared")});

/* ---------- keyboard + pointer ---------- */
document.addEventListener("keydown",function(e){
  var tag=(document.activeElement&&document.activeElement.tagName)||"";
  if(e.key==="Escape"){
    if(panel.classList.contains("on"))closePanel();
    else if(sug.classList.contains("on"))closeSug();
    else q.blur();
    return;
  }
  if(e.key==="/"&&tag!=="INPUT"&&tag!=="TEXTAREA"){e.preventDefault();q.focus()}
});
if(window.matchMedia("(hover:hover)").matches)setTimeout(function(){if(!panel.classList.contains("on"))q.focus()},reduce?0:2600);

window.addEventListener("pointermove",function(e){
  mx=e.clientX/cw;my=e.clientY/ch;
  var b=bar.getBoundingClientRect();
  bar.style.setProperty("--mx",(e.clientX-b.left)+"px");
  bar.style.setProperty("--my",(e.clientY-b.top)+"px");
});
window.addEventListener("pointerdown",function(e){
  if(e.target===document.body||e.target===cv||e.target===hero)ripple(.6);
});
document.addEventListener("pointerleave",function(){mx=my=-999});
window.addEventListener("pageshow",function(e){
  if(e.persisted){leaving=false;document.body.classList.remove("leaving");gTarget=.6;q.value="";bar.classList.remove("has");renderChips()}
});

CL.armPanic();
CL.applyCloak();

/* ---------- startup ---------- */
layout();started=true;t0=performance.now();
if(reduce){draw(100)}else{requestAnimationFrame(frame)}
setTimeout(function(){if(started){layout();if(reduce)draw(100)}},650);
var rz;window.addEventListener("resize",function(){clearTimeout(rz);rz=setTimeout(function(){if(started){layout();if(reduce)draw(100)}},120)});
})();
</script>
</body></html>`;

/* ============================== GALLIUM BACKEND ============================== */
/* Two OpenAI-compatible upstreams, kept internal. Model keys are "g:<id>" and "p:<id>"; the UI never shows the prefix. */

const GAL_DEFAULT_MAX = 16384;

const PROVIDERS = {
  g: {
    chat: "https://api.groq.com/openai/v1/chat/completions",
    models: ["https://api.groq.com/openai/v1/models"],
    keys: GROQ_KEYS,
    tokenField: "max_completion_tokens",
    needsKey: true,
  },
  p: {
    chat: "https://gen.pollinations.ai/v1/chat/completions",
    models: ["https://gen.pollinations.ai/v1/models", "https://gen.pollinations.ai/text/models"],
    keys: POLLINATIONS_KEYS,
    tokenField: "max_tokens",
    needsKey: false,
  },
};

const KS = { g: { next: 0, cool: {} }, p: { next: 0, cool: {} } };
const LIMITS = new Map();
const MODELS_CACHE = { at: 0, list: null };

const FALLBACK_G = [
  "llama-3.3-70b-versatile",
  "llama-3.1-8b-instant",
  "openai/gpt-oss-120b",
  "openai/gpt-oss-20b",
  "meta-llama/llama-4-scout-17b-16e-instruct",
  "meta-llama/llama-4-maverick-17b-128e-instruct",
  "qwen/qwen3-32b",
  "moonshotai/kimi-k2-instruct",
  "moonshotai/kimi-k2-instruct-0905",
  "deepseek-r1-distill-llama-70b",
  "gemma2-9b-it",
  "llama3-70b-8192",
];
const FALLBACK_P = [
  "openai", "openai-fast", "openai-large", "claude", "claude-large", "gemini", "gemini-fast",
  "deepseek", "grok", "mistral", "qwen-coder", "kimi", "glm", "perplexity-fast",
];
const VISION_RE = /llama-4|vision|gemini|claude|^openai($|-fast|-large)|gpt-4o|gpt-5|pixtral|-vl/i;
const MODEL_DROP = /whisper|tts|guard|embed|moderat|image|audio|speech|transcri|dall|flux|sdxl|video|rerank|orpheus|playai|compound|^groq\//i;

function displayName(id) {
  return String(id).split("/").pop();
}
const FALLBACK_MODELS = []
  .concat(FALLBACK_G.map((n) => ({ id: "g:" + n, name: displayName(n), vision: VISION_RE.test(n) })))
  .concat(FALLBACK_P.map((n) => ({ id: "p:" + n, name: displayName(n), vision: VISION_RE.test(n) })));

function validKeys(list) {
  return (list || []).filter((k) => typeof k === "string" && k.length > 8 && !/^PASTE_KEY/i.test(k));
}
function keyOrder(pv) {
  const st = KS[pv];
  const keys = validKeys(PROVIDERS[pv].keys);
  const n = keys.length;
  if (!n) return [];
  const now = Date.now();
  const order = [];
  for (let k = 0; k < n; k++) order.push((st.next + k) % n);
  st.next = (st.next + 1) % n;
  const ready = order.filter((i) => (st.cool[i] || 0) <= now);
  if (ready.length) return ready.map((i) => ({ i, key: keys[i] }));
  order.sort((a, b) => (st.cool[a] || 0) - (st.cool[b] || 0));
  return [{ i: order[0], key: keys[order[0]] }];
}
function cooldown(pv, i, ms) {
  if (i < 0) return;
  KS[pv].cool[i] = Date.now() + ms;
}
function retryAfter(res) {
  let s = parseFloat(res.headers.get("retry-after"));
  if (!isFinite(s)) s = 30;
  return Math.min(Math.max(s, 1), 3600) * 1000;
}

async function listFrom(pv) {
  const P = PROVIDERS[pv];
  let tries = keyOrder(pv);
  if (!tries.length) {
    if (P.needsKey) return [];
    tries = [{ i: -1, key: null }];
  }
  for (const url of P.models) {
    for (const k of tries.slice(0, 2)) {
      try {
        const r = await fetch(url, {
          headers: k.key ? { authorization: "Bearer " + k.key } : {},
          signal: AbortSignal.timeout(6000),
        });
        if (!r.ok) {
          if (r.status === 401 || r.status === 403) cooldown(pv, k.i, 600000);
          else if (r.status === 429) cooldown(pv, k.i, retryAfter(r));
          continue;
        }
        const j = await r.json();
        const arr = Array.isArray(j) ? j : j.data || j.models || [];
        const out = [];
        for (const m of arr) {
          const id = typeof m === "string" ? m : m && (m.id || m.name);
          if (!id || typeof id !== "string" || MODEL_DROP.test(id)) continue;
          if (m && typeof m === "object") {
            if (m.active === false) continue;
            if (Array.isArray(m.output_modalities) && !m.output_modalities.includes("text")) continue;
            if (Array.isArray(m.modalities) && m.modalities.length && !m.modalities.includes("text")) continue;
          }
          const vision = !!(m && Array.isArray(m.input_modalities) && m.input_modalities.includes("image")) || VISION_RE.test(id);
          out.push({ id: pv + ":" + id, name: displayName(id), vision });
        }
        if (out.length) return out;
      } catch {}
    }
  }
  return [];
}

async function fetchModels() {
  const now = Date.now();
  if (MODELS_CACHE.list && now - MODELS_CACHE.at < 300000) return MODELS_CACHE.list;
  const [g, p] = await Promise.all([listFrom("g"), listFrom("p")]);
  const out = [];
  const seen = new Set();
  for (const m of [].concat(g, p, FALLBACK_MODELS)) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(m);
  }
  MODELS_CACHE.list = out;
  MODELS_CACHE.at = now;
  return out;
}

function sanitizeMessages(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const x of arr.slice(-200)) {
    if (!x || typeof x !== "object") continue;
    const role = x.role === "assistant" ? "assistant" : x.role === "system" ? "system" : "user";
    let text = typeof x.content === "string" ? x.content : "";
    if (text.length > 600000) text = text.slice(0, 600000);
    const imgs = role === "user" && Array.isArray(x.images)
      ? x.images.filter((u) => typeof u === "string" && u.length < 8e6 && /^data:image\/(?:png|jpe?g|gif|webp);base64,[A-Za-z0-9+\/=]+$/.test(u)).slice(0, 5)
      : [];
    if (!text && !imgs.length) continue;
    if (imgs.length) {
      const parts = [];
      if (text) parts.push({ type: "text", text });
      for (const u of imgs) parts.push({ type: "image_url", image_url: { url: u } });
      out.push({ role, content: parts });
    } else {
      out.push({ role, content: text });
    }
  }
  return out;
}

function numClamp(v, d, lo, hi) {
  v = Number(v);
  if (!isFinite(v)) return d;
  return Math.min(hi, Math.max(lo, v));
}

function buildBody(pv, model, m, messages) {
  const P = PROVIDERS[pv];
  const body = {
    model,
    messages,
    stream: true,
    temperature: numClamp(m.temperature, 0.7, 0, 2),
    top_p: numClamp(m.top_p, 1, 0, 1),
  };
  let mt = Math.round(numClamp(m.max_tokens, GAL_DEFAULT_MAX, 256, 131072));
  const cached = LIMITS.get(pv + ":" + model);
  if (cached && mt > cached) mt = cached;
  body[P.tokenField] = mt;
  if (/gpt-oss/i.test(model) && ["low", "medium", "high"].includes(m.effort)) body.reasoning_effort = m.effort;
  if (pv === "g" && /qwen3|deepseek-r1/i.test(model)) body.reasoning_format = "parsed";
  return body;
}

function extractErr(text) {
  try {
    const j = JSON.parse(text);
    const e = j.error !== undefined ? j.error : j.message !== undefined ? j.message : j;
    if (typeof e === "string") return e;
    if (e && typeof e.message === "string") return e.message;
    return JSON.stringify(e).slice(0, 400);
  } catch {
    return String(text || "").slice(0, 400);
  }
}
function parseLimit(text) {
  if (!/token|max_/i.test(text)) return 0;
  const m = /(?:less than or equal to|at most|maximum[^0-9]{0,60}?is|limit[^0-9]{0,20}is|must be <=?)[^0-9]{0,16}(\d{3,7})/i.exec(text);
  return m ? parseInt(m[1], 10) : 0;
}
function dropParam(text, body, tf) {
  const lower = String(text || "").toLowerCase();
  if (!/unsupported|not support|unknown|unrecognized|invalid|not permitted|not allowed|extra|deprecated|only the default/.test(lower)) return false;
  for (const k of [tf, "max_tokens", "max_completion_tokens", "reasoning_effort", "reasoning_format", "top_p", "temperature"]) {
    if (k in body && lower.includes(k)) {
      delete body[k];
      return true;
    }
  }
  return false;
}
function scrubProvider(s) {
  return String(s).replace(/groq|pollinations/gi, "upstream");
}

async function upstreamFetch(pv, model, body, signal) {
  const P = PROVIDERS[pv];
  const tf = P.tokenField;
  let keys = keyOrder(pv);
  if (!keys.length) {
    if (P.needsKey) throw new Error("no api key configured for this model");
    keys = [{ i: -1, key: null }];
  }
  let lastErr = "request failed";
  for (const k of keys) {
    for (let attempt = 0; attempt < 6; attempt++) {
      const headers = { "content-type": "application/json" };
      if (k.key) headers.authorization = "Bearer " + k.key;
      let res;
      try {
        res = await fetch(P.chat, { method: "POST", headers, body: JSON.stringify(body), signal });
      } catch (e) {
        if (signal.aborted) throw e;
        lastErr = "network error";
        break;
      }
      if (res.ok && res.body) return res;
      const text = await res.text().catch(() => "");
      lastErr = extractErr(text) || "http " + res.status;
      if (res.status === 404 || res.status >= 500 || /does not exist|no access/i.test(text)) break;
      if (res.status === 429) { cooldown(pv, k.i, retryAfter(res)); break; }
      if (res.status === 401 || res.status === 403) { cooldown(pv, k.i, 600000); break; }
      if (res.status === 400 || res.status === 422) {
        const lim = parseLimit(text);
        if (lim && body[tf] && lim < body[tf]) {
          body[tf] = lim;
          LIMITS.set(pv + ":" + model, lim);
          continue;
        }
        if (dropParam(text, body, tf)) continue;
        throw new Error(lastErr);
      }
      throw new Error(lastErr);
    }
  }
  throw new Error(lastErr);
}

async function pumpStream(res, id, send) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let finish = null;
  let sawDone = false;
  const handle = (line) => {
    line = line.trim();
    if (!line || line.charAt(0) === ":" || !line.startsWith("data:")) return;
    const d = line.slice(5).trim();
    if (d === "[DONE]") { sawDone = true; return; }
    let j;
    try { j = JSON.parse(d); } catch { return; }
    if (j && j.error) throw new Error(extractErr(JSON.stringify(j)));
    const ch = j && j.choices && j.choices[0];
    if (!ch) return;
    const dl = ch.delta || {};
    const c = typeof dl.content === "string" ? dl.content : "";
    const r = typeof dl.reasoning_content === "string" ? dl.reasoning_content : typeof dl.reasoning === "string" ? dl.reasoning : "";
    if (c || r) send({ type: "delta", id, content: c, reasoning: r });
    if (ch.finish_reason) finish = ch.finish_reason;
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      handle(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  }
  buf += dec.decode();
  if (buf.trim()) handle(buf); // final line without trailing newline
  if (!finish) finish = sawDone ? "stop" : "length";
  return finish;
}

async function galChat(m, send, jobs) {
  const id = String(m.id || "").slice(0, 64);
  if (!id) return;
  const ctrl = new AbortController();
  jobs.set(id, ctrl);
  try {
    const mk = String(m.model || "");
    const pv = mk.slice(0, 2) === "g:" ? "g" : mk.slice(0, 2) === "p:" ? "p" : null;
    const model = mk.slice(2);
    if (!pv || !model || model.length > 120) throw new Error("unknown model");
    const messages = sanitizeMessages(m.messages);
    if (!messages.length) throw new Error("empty conversation");
    const body = buildBody(pv, model, m, messages);
    const up = await upstreamFetch(pv, model, body, ctrl.signal);
    const finish = await pumpStream(up, id, send);
    send({ type: "done", id, finish });
  } catch (e) {
    if (ctrl.signal.aborted) send({ type: "done", id, finish: "stop" });
    else send({ type: "error", id, message: scrubProvider((e && e.message) || e).slice(0, 600) });
  } finally {
    jobs.delete(id);
  }
}

function handleGallium(request) {
  if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket") return txt("Expected upgrade", 426);
  const [client, server] = Object.values(new WebSocketPair());
  server.accept();
  const jobs = new Map();
  const send = (o) => { try { server.send(JSON.stringify(o)); } catch {} };
  server.addEventListener("message", (ev) => {
    if (typeof ev.data !== "string") return;
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (!m || typeof m !== "object") return;
    switch (m.type) {
      case "ping":
        send({ type: "pong" });
        break;
      case "models":
        fetchModels().then((list) => send({ type: "models", list })).catch(() => send({ type: "models", list: FALLBACK_MODELS }));
        break;
      case "stop": {
        const c = jobs.get(String(m.id || ""));
        if (c) { try { c.abort(); } catch {} }
        break;
      }
      case "chat":
        galChat(m, send, jobs);
        break;
    }
  });
  const killAll = () => {
    for (const c of jobs.values()) { try { c.abort(); } catch {} }
    jobs.clear();
  };
  server.addEventListener("close", killAll);
  server.addEventListener("error", killAll);
  return new Response(null, { status: 101, webSocket: client });
}

/* ============================== LOGO ============================== */
/* Faceted gallium crystal: flat grayscale polygons, 1px seams, no gradients. */

const MARK_POLYS =
  '<g stroke="#000" stroke-width="1" stroke-linejoin="round">' +
  '<polygon points="16,2 6,18 16,21" fill="#d6d6d6"/>' +
  '<polygon points="16,2 16,21 26,18" fill="#fafafa"/>' +
  '<polygon points="6,18 4,25 16,21" fill="#7c7c7c"/>' +
  '<polygon points="26,18 28,25 16,21" fill="#a9a9a9"/>' +
  '<polygon points="4,25 8,33 16,21" fill="#4a4a4a"/>' +
  '<polygon points="28,25 24,33 16,21" fill="#6b6b6b"/>' +
  '<polygon points="8,33 16,38 16,21" fill="#2b2b2b"/>' +
  '<polygon points="24,33 16,38 16,21" fill="#8f8f8f"/>' +
  "</g>" +
  '<polygon points="16,2 26,18 28,25 24,33 16,38 8,33 4,25 6,18" fill="none" stroke="#fff" stroke-opacity=".55" stroke-width="1" stroke-linejoin="round"/>';

function markSvg(cls) {
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 40" class="' + cls + '" aria-hidden="true">' + MARK_POLYS + "</svg>";
}
const FAVICON = "data:image/svg+xml," + encodeURIComponent(markSvg("fav"));

/* ============================== SHARED ASCII ART ENGINE (Creation of Adam) ============================== */
/* Procedural, monochrome, Canvas2D only. Based on cellar's engine: glyph atlas, reveal, flashlight, ripples, sweep, motes. */

const ART_ENGINE = String.raw`var AsciiArt=(function(){
"use strict";
var RAMP=" .:-=+*#%@",NOISE="/\\|<>[]{}()01xo?&;^~",ALL=RAMP+NOISE;
var ANCHOR=.37;
function rng(a){return function(){a|=0;a=a+0x6D2B79F5|0;var t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}
function hash(a,b){var h=Math.imul(a^Math.imul(b,0x9E3779B1),0x85EBCA6B);h^=h>>>13;h=Math.imul(h,0xC2B2AE35);h^=h>>>16;return h>>>0}
function clamp(v,a,b){return v<a?a:v>b?b:v}
function smooth(a,b,x){x=clamp((x-a)/(b-a),0,1);return x*x*(3-2*x)}

function paintAdam(g){
  var R=rng(11),ops=[];
  function gr(v){v=clamp(v,0,1);var n=Math.round(v*255);return "rgb("+n+","+n+","+n+")"}
  function flush(){var i;for(i=0;i<ops.length;i++)ops[i](true);for(i=0;i<ops.length;i++)ops[i](false);ops=[]}
  function path(p,closed){
    var n=p.length,i,a,b;
    g.beginPath();
    if(closed){
      g.moveTo((p[n-1][0]+p[0][0])/2,(p[n-1][1]+p[0][1])/2);
      for(i=0;i<n;i++){a=p[i];b=p[(i+1)%n];g.quadraticCurveTo(a[0],a[1],(a[0]+b[0])/2,(a[1]+b[1])/2)}
      g.closePath();
    }else{
      g.moveTo(p[0][0],p[0][1]);
      for(i=1;i<n-1;i++){a=p[i];b=p[i+1];g.quadraticCurveTo(a[0],a[1],(a[0]+b[0])/2,(a[1]+b[1])/2)}
      g.lineTo(p[n-1][0],p[n-1][1]);
    }
  }
  function cap(a,b,w1,w2,col){
    var dx=b[0]-a[0],dy=b[1]-a[1],l=Math.sqrt(dx*dx+dy*dy)||1,nx=-dy/l,ny=dx/l;
    g.fillStyle=col;
    g.beginPath();
    g.moveTo(a[0]+nx*w1/2,a[1]+ny*w1/2);g.lineTo(b[0]+nx*w2/2,b[1]+ny*w2/2);
    g.lineTo(b[0]-nx*w2/2,b[1]-ny*w2/2);g.lineTo(a[0]-nx*w1/2,a[1]-ny*w1/2);
    g.closePath();g.fill();
    g.beginPath();g.arc(a[0],a[1],w1/2,0,7);g.fill();
    g.beginPath();g.arc(b[0],b[1],w2/2,0,7);g.fill();
  }
  function limb(a,b,w1,w2,v){ops.push(function(d){
    if(d){cap(a,b,w1+1.4,w2+1.4,gr(.06));return}
    cap(a,b,w1,w2,gr(v));
    cap([a[0]-w1*.12,a[1]-w1*.18],[b[0]-w2*.12,b[1]-w2*.18],w1*.45,w2*.45,gr(v+.12));
  })}
  function ell(x,y,rx,ry,rot,v,hl){ops.push(function(d){
    g.beginPath();g.ellipse(x,y,rx+(d?.7:0),ry+(d?.7:0),rot,0,7);
    g.fillStyle=gr(d?.06:v);g.fill();
    if(!d&&hl){g.beginPath();g.ellipse(x-rx*.25,y-ry*.25,rx*.55,ry*.55,rot,0,7);g.fillStyle=gr(v+.1);g.fill()}
  })}
  function poly(p,v,gd){ops.push(function(d){
    path(p,true);
    if(d){g.lineJoin="round";g.lineWidth=1.3;g.strokeStyle=gr(.06);g.stroke();return}
    if(gd){var lg=g.createLinearGradient(gd[0],gd[1],gd[2],gd[3]);lg.addColorStop(0,gr(gd[4]));lg.addColorStop(1,gr(gd[5]));g.fillStyle=lg}
    else g.fillStyle=gr(v);
    g.fill();
  })}
  function line(p,w,v){ops.push(function(d){if(d)return;path(p,false);g.lineWidth=w;g.lineCap="round";g.strokeStyle=gr(v);g.stroke()})}

  var hz=g.createRadialGradient(100,46,0,100,46,110);
  hz.addColorStop(0,"rgba(255,255,255,.2)");hz.addColorStop(1,"rgba(255,255,255,0)");
  g.fillStyle=hz;g.fillRect(-300,-300,800,800);

  var GP=[[-80,63],[-20,60],[10,62],[32,66],[60,73],[84,82],[102,94],[120,125],[134,160]];
  function gy(x){for(var i=1;i<GP.length;i++){if(x<=GP[i][0]){var a=GP[i-1],b=GP[i];return a[1]+(b[1]-a[1])*(x-a[0])/(b[0]-a[0])}}return 160}
  ops.push(function(d){
    if(d)return;
    path(GP,false);g.lineTo(140,175);g.lineTo(-80,175);g.closePath();
    var gg=g.createLinearGradient(0,60,0,130);gg.addColorStop(0,gr(.34));gg.addColorStop(1,gr(.08));
    g.fillStyle=gg;g.fill();
    g.lineWidth=.4;g.lineCap="round";
    for(var i=0;i<150;i++){
      var x=-70+R()*190,y=gy(x)+1+R()*18;
      g.strokeStyle=gr(.2+R()*.3);g.beginPath();g.moveTo(x,y);g.lineTo(x+(R()-.5)*1.2,y-1.2-R()*1.8);g.stroke();
    }
    path(GP,false);g.lineWidth=.6;g.strokeStyle=gr(.55);g.stroke();
  });
  flush();

  var cloak=[[118,24],[130,10],[152,4],[176,10],[192,26],[196,48],[188,66],[170,78],[146,80],[126,70],[113,52],[111,36]];
  ops.push(function(d){
    if(d)return;
    path(cloak,true);
    var rg=g.createRadialGradient(140,26,4,150,45,64);rg.addColorStop(0,gr(.62));rg.addColorStop(1,gr(.28));
    g.fillStyle=rg;g.fill();g.lineWidth=.7;g.strokeStyle=gr(.7);g.stroke();
  });
  line([[140,10],[136,30],[140,52],[150,72]],.9,.18);
  line([[160,6],[158,26],[168,46],[178,66]],.9,.18);
  line([[178,14],[176,30],[184,44],[190,58]],.8,.18);
  line([[128,66],[140,62],[150,58]],.8,.2);
  line([[146,8],[144,28],[150,50],[158,70]],.5,.75);
  line([[168,8],[168,26],[176,46],[184,62]],.5,.75);
  line([[120,28],[122,14],[134,8]],.5,.75);
  flush();

  limb([160,31],[163,41],4.2,3.2,.85);ell(160,28,2.8,3,0,.9,1);
  limb([167.5,38],[172,47],4,3,.85);ell(167.5,35,2.6,2.9,0,.9,1);
  limb([146,27],[143,35],4,3,.84);ell(146,24,2.6,2.8,0,.88,1);
  ell(154,36.5,3.6,7,.2,.42);
  limb([150.5,38],[158,53],6,5,.8);ell(151,33,3.3,4,.1,.88,1);
  limb([138,68.5],[143,76],3.6,2.6,.82);ell(138,66,2.3,2.5,0,.88,1);
  limb([130,65.5],[134,72],3.4,2.5,.82);ell(130,63,2.2,2.4,0,.88,1);
  limb([177,71.5],[182,77],3.6,2.6,.82);ell(177,69,2.4,2.6,0,.88,1);
  poly([[146,52],[160,49],[176,53],[192,61],[199,70],[188,75],[172,71],[156,67],[145,60]],0,[146,50,196,74,.92,.6]);
  ell(195,70,3,1.6,.3,.9);
  line([[158,56],[170,62],[184,67]],.6,.42);line([[152,58],[162,66],[174,71]],.5,.42);
  poly([[128,40],[138,36],[150,40],[160,48],[164,60],[154,64],[142,58],[132,50]],0,[130,36,160,64,.98,.62]);
  limb([142,39],[150.5,43],4.2,3.6,.9);ell(153,41,2,1.6,0,.93,1);
  poly([[121,27],[127,23],[136,25],[145,31],[152,39],[142,40],[133,37],[124,37]],.95);
  line([[128,26],[138,29],[148,35]],.4,.6);line([[126,29],[136,32],[145,38]],.4,.6);
  ell(126,33,4.8,6,-.1,.72);
  poly([[120.5,36],[126,35],[131,39],[130,46],[125,51],[120,46],[119,40]],.98);
  line([[123,42],[124,48]],.4,.65);line([[126.5,41],[127.5,47]],.4,.65);
  line([[122.4,31],[125,30.5]],.8,.15);line([[126.5,31],[129,31.2]],.8,.15);line([[125,32.5],[125.6,35.5]],.6,.45);
  limb([132,43],[121,45.5],6,4.2,.9);limb([121,45.5],[111,44.8],4.2,2.8,.92);
  ell(108.5,44.8,3,1.9,.05,.95,1);
  limb([107,44.5],[103.6,44.9],1.7,1,.98);
  limb([107.5,45.8],[104.5,47.6],1.6,1.1,.93);
  limb([108,46.4],[105.6,48.6],1.6,1.1,.93);
  limb([109,46.8],[107.2,49.4],1.5,1.1,.93);
  limb([109.5,43.5],[107.5,42.6],1.5,1.1,.93);
  flush();

  limb([54,70],[72,81],10,7,.76);limb([72,81],[93,87],7,4.5,.74);ell(97,88.5,3.5,1.6,.2,.74);
  limb([62,68],[79,58],11,7,.88);limb([79,58],[88,79],7,5,.85);ell(91,81.5,4,1.8,.2,.85);
  poly([[31,47],[38,42],[47,41],[54,44],[62,55],[68,66],[52,71],[42,62],[32,56]],0,[34,42,64,70,.98,.55]);
  limb([32,48],[22,58],7,5.5,.85);limb([22,58],[26,70],5.5,4,.8);ell(27,71,3,2,.4,.85);
  limb([42,41],[41,36],5,4.5,.8);
  ell(39.5,31,6.2,6.6,-.2,.45);
  ell(40.5,34,5.2,6.4,-.15,.9,1);
  line([[43,34],[45,34.2]],.7,.15);line([[42.5,32.2],[45,32.4]],.5,.3);line([[44.5,34.5],[45.5,37]],.6,.5);line([[43.5,39],[45,39.1]],.7,.35);
  limb([54,45],[70,48.5],7,5.5,.95);limb([70,48.5],[84,47.5],5.5,3.6,.95);
  ell(86.8,47.6,3.2,2,.1,.97,1);
  limb([88.5,47],[96,45.6],1.9,1.1,1);
  limb([88,48.4],[93.5,50.6],1.8,1.2,.95);
  limb([87.4,49],[91.4,52.2],1.7,1.2,.95);
  limb([86.4,49.2],[89.2,52.2],1.5,1.1,.95);
  limb([86,46.2],[89,44.4],1.8,1.2,.95);
  flush();
}

function create(cv,o){
  o=o||{};
  var ctx=cv.getContext("2d");
  var reduce=window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var S={bright:o.brightness==null?.4:o.brightness,speed:o.speed==null?1:o.speed,cell:o.cell||9,contrast:o.contrast||1.58,on:o.enabled!==false};
  var W,H,dpr,fs,cw,ch,cols,rows,gw,gh,atlas,lum,mask,dist,noise,motes=[];
  var mx=-999,my=-999,smx=-999,smy=-999,ripples=[],gA=.6,t=0,lastDraw=0,started=false;
  var artKT=S.on?1:0,artK=artKT,cleared=false;

  function computeMask(){
    var r,c;
    for(r=0;r<rows;r++)for(c=0;c<cols;c++)mask[r*cols+c]=o.mask?clamp(o.mask((c+.5)*cw,(r+.5)*ch,W,H),0,1):1;
  }

  function layout(){
    if(o.before)o.before();
    W=window.innerWidth;H=window.innerHeight;dpr=Math.min(window.devicePixelRatio||1,2);
    fs=Math.max(S.cell,Math.min(S.cell*1.67,W/135));cw=fs*.6;ch=fs;
    cols=Math.ceil(W/cw);rows=Math.ceil(H/ch);
    cv.width=Math.round(W*dpr);cv.height=Math.round(H*dpr);

    gw=Math.ceil(cw*dpr);gh=Math.ceil(ch*dpr);
    atlas=document.createElement("canvas");atlas.width=gw*ALL.length;atlas.height=gh;
    var a=atlas.getContext("2d");
    a.fillStyle="#fff";a.font="600 "+(fs*dpr)+"px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";
    a.textAlign="center";a.textBaseline="middle";
    for(var i=1;i<ALL.length;i++)a.fillText(ALL.charAt(i),i*gw+gw/2,gh/2+dpr*.5);

    var S3=3,aw=cols*S3,ah=rows*S3;
    var oc=document.createElement("canvas");oc.width=aw;oc.height=ah;
    var g=oc.getContext("2d",{willReadFrequently:true});
    g.fillStyle="#000";g.fillRect(0,0,aw,ah);
    var s=Math.max(W/200,H/150);
    g.setTransform(S3/cw,0,0,S3/ch,0,0);
    g.translate(W/2-100*s,H*ANCHOR-46*s);
    g.scale(s,s);
    paintAdam(g);
    var d=g.getImageData(0,0,aw,ah).data;

    var n=cols*rows;
    lum=new Float32Array(n);mask=new Float32Array(n);dist=new Float32Array(n);noise=new Float32Array(n);
    var hx=(W/2)/cw,hy=(H*ANCHOR-.5*s)/ch;
    var nr=rng(5),r,c,j,k,sum;
    for(r=0;r<rows;r++)for(c=0;c<cols;c++){
      i=r*cols+c;sum=0;
      for(j=0;j<S3;j++)for(k=0;k<S3;k++)sum+=d[((r*S3+j)*aw+c*S3+k)*4];
      var l=Math.pow(sum/(S3*S3*255),.85);
      lum[i]=clamp((l-.4)*S.contrast+.4,0,1);
      var dx=c+.5-hx,dy=(r+.5-hy)*ch/cw;
      dist[i]=Math.sqrt(dx*dx+dy*dy);
      noise[i]=nr();
    }
    computeMask();
    motes=[];
    for(i=0;i<46;i++)motes.push({x:nr()*cols,y:nr()*rows,sp:.6+nr()*1.6,ph:nr()*6.28,g:nr()<.6?1:2});
  }

  function draw(tt){
    var r,c,i,k;
    artK+=(artKT-artK)*.12;
    ctx.setTransform(dpr,0,0,dpr,0,0);
    ctx.clearRect(0,0,W,H);
    smx+=(mx-smx)*.2;smy+=(my-smy)*.2;
    gA+=(.6-gA)*.06;
    var R0=(tt-.15)*95;
    var sweep=(tt*16)%(cols*.6+rows+80)-40;
    var pulse=.55+.45*Math.sin(tt*2.2);
    var ringR=(tt*11)%46,ringA=(1-ringR/46)*.3;
    var flick=Math.floor(tt*7),dec=Math.floor(tt*16);
    var L1=RAMP.length-1,NL=NOISE.length,B=S.bright;
    for(k=ripples.length-1;k>=0;k--)if(tt-ripples[k].t>1.8)ripples.splice(k,1);

    for(r=0;r<rows;r++){
      for(c=0;c<cols;c++){
        i=r*cols+c;
        var d=dist[i],rv=R0-d-noise[i]*14;
        if(rv<0)continue;
        var idx,alpha,m=mask[i];
        var ddx=c-smx,ddy=(r-smy)*1.67,dm2=ddx*ddx+ddy*ddy;
        var fl=dm2<700?Math.exp(-dm2/150):0;
        m=m+(1-m)*fl*.7;
        if(rv<16){
          idx=RAMP.length+(hash(i,dec)%NL);
          alpha=(rv/16)*.85*(.3+.7*m);
        }else{
          var base=lum[i]*m,v=base;
          v*=.8+.2*Math.sin(tt*.9+c*.045+r*.09);
          var sd=(c*.6+r)-sweep;
          if(sd<20&&sd>-20)v+=base*Math.exp(-sd*sd/64)*.6;
          v*=1+fl*1.1;
          if(d<22)v+=Math.exp(-d*d/30)*pulse*.57;
          var rd=d-ringR;
          if(rd<6&&rd>-6)v+=Math.exp(-rd*rd/3)*ringA;
          for(k=0;k<ripples.length;k++){
            var age=tt-ripples[k].t,rr=d-age*70;
            if(rr<6&&rr>-6)v+=Math.exp(-rr*rr/4)*ripples[k].a*(1-age/1.8);
          }
          if(v<.04)continue;
          v=v>1?1:v;
          idx=(v*L1)|0;
          if((hash(i,flick)&63)===0)idx+=(hash(i,flick+9)&1)?1:-1;
          if(idx>L1)idx=L1;
          if(idx<=0)continue;
          alpha=Math.min(1,.3+v*.85)*gA/.6*.6;
        }
        ctx.globalAlpha=alpha*artK*B;
        ctx.drawImage(atlas,idx*gw,0,gw,gh,c*cw,r*ch,cw,ch);
      }
    }
    if(tt>1.6){
      for(k=0;k<motes.length;k++){
        var p=motes[k];
        var y=((p.y-tt*p.sp)%rows+rows)%rows,x=p.x+Math.sin(tt*.5+p.ph)*3;
        ctx.globalAlpha=(.15+.35*(.5+.5*Math.sin(tt*1.7+p.ph)))*Math.min(1,(tt-1.6))*artK*B;
        ctx.drawImage(atlas,p.g*gw,0,gw,gh,x*cw,y*ch,cw,ch);
      }
    }
    ctx.globalAlpha=1;
  }

  function frame(now){
    requestAnimationFrame(frame);
    if(document.hidden){lastDraw=now;return}
    if(now-lastDraw<32)return;
    var dt=Math.min((now-lastDraw)/1000,.1);
    lastDraw=now;
    if(!S.on&&artK<.005){
      if(!cleared){ctx.setTransform(1,0,0,1,0,0);ctx.clearRect(0,0,cv.width,cv.height);cleared=true}
      return;
    }
    t+=dt*S.speed;
    draw(t);
  }

  function ripple(a){ripples.push({t:t,a:a});if(ripples.length>6)ripples.shift()}
  window.addEventListener("pointermove",function(e){mx=e.clientX/cw;my=e.clientY/ch});
  window.addEventListener("pointerdown",function(){ripple(.4)});
  document.addEventListener("pointerleave",function(){mx=my=-999});
  var rz;
  window.addEventListener("resize",function(){clearTimeout(rz);rz=setTimeout(function(){if(started){layout();if(reduce)draw(100)}},150)});

  layout();started=true;
  if(reduce){artK=artKT;draw(100)}else requestAnimationFrame(frame);

  return {
    setBrightness:function(v){S.bright=clamp(v,0,1);if(reduce&&started)draw(100)},
    setSpeed:function(v){S.speed=clamp(v,.05,4)},
    setEnabled:function(b){S.on=!!b;artKT=S.on?1:0;cleared=false;if(reduce&&started){artK=artKT;draw(100)}},
    setCell:function(v){v=clamp(+v||9,6,24);if(v!==S.cell){S.cell=v;if(started){layout();if(reduce)draw(100)}}},
    relayout:function(){if(started){layout();if(reduce)draw(100)}},
    remask:function(){if(started){if(o.before)o.before();computeMask();if(reduce)draw(100)}},
    ripple:ripple
  };
}
return {create:create};
})();`;

/* ============================== CHOOSER PAGE ("/") ============================== */

const CHOOSER_HTML = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<title>gallium / cellar</title>
<link rel="icon" href="${FAVICON}">
<style>
:root{--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace}
*{box-sizing:border-box}
html,body{margin:0;min-height:100%;background:#000;color:#eee;font-family:var(--mono)}
body{overflow-x:hidden}
#art{position:fixed;inset:0;width:100%;height:100%;display:block;z-index:0}
.vig{position:fixed;inset:0;z-index:1;pointer-events:none;background:radial-gradient(ellipse at 50% 45%,transparent 35%,rgba(0,0,0,.82) 100%)}
.stage{position:relative;z-index:5;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:38px;padding:40px 20px}
.stage::before{content:"";position:absolute;inset:0 -6vw;z-index:-1;pointer-events:none;background:radial-gradient(closest-side,rgba(0,0,0,.85),rgba(0,0,0,.55) 62%,transparent)}
.logo{display:inline-flex;align-items:center;gap:18px}
.logo svg{width:42px;height:53px;display:block}
.wm{font-family:var(--mono);font-weight:500;letter-spacing:.34em;font-size:30px;color:#f2f2f2;margin-right:-.34em;min-width:7ch}
.cards{display:grid;grid-template-columns:1fr 1fr;gap:18px;width:min(880px,100%)}
.card{position:relative;display:flex;flex-direction:column;gap:14px;min-height:220px;padding:26px 26px 22px;border:1px solid rgba(255,255,255,.2);background:rgba(6,6,6,.74);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);color:#eee;text-decoration:none;border-radius:4px;outline:none;
  transition:border-color .18s ease,background .18s ease,transform .18s ease}
.card:hover,.card:focus-visible{border-color:rgba(255,255,255,.75);background:rgba(16,16,16,.88);transform:translateY(-3px)}
.card:focus-visible{outline:1px solid rgba(255,255,255,.75);outline-offset:4px}
.card:active{transform:translateY(-1px)}
.idx{font-size:11px;letter-spacing:.2em;color:#6d6d6d}
.card h2{margin:0;font:500 28px var(--mono);letter-spacing:.16em}
.card p{margin:0;color:#a9a9a9;font-size:14px;line-height:1.65}
.open{margin-top:auto;font-size:12px;letter-spacing:.14em;color:#8a8a8a;transition:color .18s ease,transform .18s ease}
.card:hover .open,.card:focus-visible .open{color:#fff;transform:translateX(4px)}
.hint{font-size:11px;letter-spacing:.16em;color:#5d5d5d}
.veil{position:fixed;inset:0;z-index:50;background:#000;pointer-events:none;clip-path:circle(0px at var(--vx,50%) var(--vy,50%))}
body.leaving .veil{clip-path:circle(150vmax at var(--vx,50%) var(--vy,50%));transition:clip-path .7s cubic-bezier(.7,0,.3,1)}
body.leaving .stage{pointer-events:none}
@media (max-width:700px){.cards{grid-template-columns:1fr}.card{min-height:0}.wm{font-size:24px}.stage{justify-content:flex-start;padding-top:48px}}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{transition-duration:.01ms!important;animation:none!important}}
</style></head>
<body>
<canvas id="art" aria-hidden="true"></canvas>
<div class="vig"></div>
<main class="stage" id="stage">
  <div class="logo" id="logo">${markSvg("mk")}<span class="wm" id="wm">gallium</span></div>
  <div class="cards" id="cards">
    <a class="card" id="c1" href="/gallium" data-go="/gallium" aria-keyshortcuts="1">
      <span class="idx">01</span>
      <h2>gallium</h2>
      <p>an advanced AI made to do anything.</p>
      <span class="open">open &rarr;</span>
    </a>
    <a class="card" id="c2" href="/cellar" data-go="/cellar" aria-keyshortcuts="2">
      <span class="idx">02</span>
      <h2>cellar</h2>
      <p>a web proxy using websockets. note: the proxy is slow and is not the best out there, consider other options instead.</p>
      <span class="open">open &rarr;</span>
    </a>
  </div>
  <div class="hint">arrows + enter &middot; 1 / 2</div>
</main>
<div class="veil" id="veil"></div>
<script>
${ART_ENGINE}
(function(){
"use strict";
var reduce=window.matchMedia("(prefers-reduced-motion: reduce)").matches;
var cards=[document.getElementById("c1"),document.getElementById("c2")];
var logo=document.getElementById("logo"),cardsEl=document.getElementById("cards"),veil=document.getElementById("veil");
var leaving=false,box={cx:0,cy:0,ea:1,eb:1};
function clamp(v,a,b){return v<a?a:v>b?b:v}
function smooth(a,b,x){x=clamp((x-a)/(b-a),0,1);return x*x*(3-2*x)}
function before(){
  var l=logo.getBoundingClientRect(),c=cardsEl.getBoundingClientRect();
  box.cx=(c.left+c.right)/2;box.cy=(l.top+c.bottom)/2;
  box.ea=c.width/2+90;box.eb=(c.bottom-l.top)/2+80;
}
function maskFn(x,y){
  var e=Math.sqrt(Math.pow((x-box.cx)/box.ea,2)+Math.pow((y-box.cy)/box.eb,2));
  return .1+.9*smooth(.75,1.5,e);
}
var art=AsciiArt.create(document.getElementById("art"),{brightness:.5,speed:1,cell:9,contrast:1.58,mask:maskFn,before:before});
setTimeout(function(){art.relayout()},300);

function scramble(el,text){
  if(reduce){el.textContent=text;return}
  var G="#@%&01/\\|<>*+=-",n=text.length,start=performance.now();
  (function step(){
    var t=performance.now()-start,out="",i;
    for(i=0;i<n;i++)out+=t>=350+i*110?text.charAt(i):G.charAt((Math.random()*G.length)|0);
    el.textContent=out;
    if(t<350+n*110+60)setTimeout(step,45);else el.textContent=text;
  })();
}
scramble(document.getElementById("wm"),"gallium");

function go(card){
  if(leaving||!card)return;
  leaving=true;
  var r=card.getBoundingClientRect();
  veil.style.setProperty("--vx",(r.left+r.width/2)+"px");
  veil.style.setProperty("--vy",(r.top+r.height/2)+"px");
  art.ripple(.9);
  document.body.classList.add("leaving");
  var dest=card.getAttribute("data-go");
  setTimeout(function(){
    try{window.top.location.href=dest}catch(e){window.location.href=dest}
  },reduce?0:720);
}
cards.forEach(function(c){
  c.addEventListener("click",function(e){
    if(e.metaKey||e.ctrlKey||e.shiftKey||e.button!==0)return;
    e.preventDefault();go(c);
  });
});
function cur(){return cards.indexOf(document.activeElement)}
document.addEventListener("keydown",function(e){
  if(e.altKey||e.ctrlKey||e.metaKey)return;
  var k=e.key,i=cur();
  if(k==="1"){e.preventDefault();go(cards[0])}
  else if(k==="2"){e.preventDefault();go(cards[1])}
  else if(k==="ArrowRight"||k==="ArrowDown"){e.preventDefault();cards[i<0?0:(i+1)%cards.length].focus()}
  else if(k==="ArrowLeft"||k==="ArrowUp"){e.preventDefault();cards[i<0?cards.length-1:(i-1+cards.length)%cards.length].focus()}
  else if(k==="Enter"){if(i>=0){e.preventDefault();go(cards[i])}}
});
window.addEventListener("pageshow",function(e){
  if(e.persisted){leaving=false;document.body.classList.remove("leaving")}
});
})();
</script>
</body></html>`;

function chooserPage() {
  return CHOOSER_HTML;
}

/* ============================== GALLIUM PAGE (outer shell + single iframe) ============================== */

let GAL_SHELL_CACHE = null;

function galAppHtml() {
  const js = (GAL_JS1 + GAL_JS2 + GAL_JS3).split("__INITIAL_MODELS__").join(JSON.stringify(FALLBACK_MODELS));
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark">' +
    "<title>gallium</title>" +
    '<link rel="icon" href="' + FAVICON + '">' +
    "<style>" + GAL_CSS + "</style></head><body>" + GAL_BODY +
    "<script>" + ART_ENGINE + "\n" + js + "</" + "script></body></html>"
  );
}

function galliumPage() {
  if (!GAL_SHELL_CACHE) {
    GAL_SHELL_CACHE =
      '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark">' +
      "<title>gallium</title>" +
      '<link rel="icon" href="' + FAVICON + '">' +
      "<style>html,body{margin:0;width:100%;height:100%;background:#000;overflow:hidden}iframe{display:block;width:100%;height:100%;border:0}</style>" +
      '</head><body><iframe id="f" title="gallium" allow="clipboard-read; clipboard-write" srcdoc="' + esc(galAppHtml()) + '"></iframe>' +
      '<script>var f=document.getElementById("f");f.addEventListener("load",function(){try{f.contentWindow.focus()}catch(e){}})</' + "script></body></html>";
  }
  return GAL_SHELL_CACHE;
}

/* ============================== GALLIUM APP: CSS + MARKUP ============================== */

const GAL_CSS = String.raw`
:root{--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;--sans:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;--serif:Georgia,"Times New Roman",serif;
--fs:15px;--cfs:13px;--cw:820px;--blur:18px;--glass:.62;--r:14px;--ctl-r:20px;--sbw:280px;--gap:10px;
--line:rgba(255,255,255,.12);--line2:rgba(255,255,255,.24);--fg:#ececec;--mut:#8a8a8a;--mut2:#5f5f5f;
--panel:rgba(12,12,12,var(--glass));--panel2:rgba(255,255,255,.05);--msgfont:var(--sans)}
*{box-sizing:border-box;scrollbar-width:thin;scrollbar-color:#555 transparent}
html,body{height:100%;margin:0;background:#000;color:var(--fg);font:var(--fs)/1.55 var(--sans);overflow:hidden}
button,input,textarea,select{font-family:inherit;color:inherit}
::selection{background:rgba(255,255,255,.28)}
::-webkit-scrollbar{width:9px;height:9px}
::-webkit-scrollbar-thumb{background:#4a4a4a;border-radius:6px;border:2px solid transparent;background-clip:padding-box}
::-webkit-scrollbar-thumb:hover{background:#666;background-clip:padding-box;border:2px solid transparent}
::-webkit-scrollbar-track{background:transparent}
#art{position:fixed;inset:0;width:100%;height:100%;display:block;z-index:0}
#trail{position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:200}
.app{position:relative;z-index:1;display:flex;height:100%;padding:var(--gap);gap:var(--gap)}
.glass{background:var(--panel);-webkit-backdrop-filter:blur(var(--blur));backdrop-filter:blur(var(--blur));border:1px solid var(--line);border-radius:calc(var(--r) + 4px)}

/* logo */
.logo{display:inline-flex;align-items:center;gap:11px;min-width:0}
.logo svg{width:20px;height:25px;flex:none;display:block}
.wm{font-family:var(--mono);font-weight:500;letter-spacing:.3em;font-size:14px;color:#f2f2f2;text-transform:lowercase;margin-right:-.3em}

/* sidebar */
.sb{width:var(--sbw);flex:none;display:flex;flex-direction:column;overflow:hidden;transition:width .22s ease,margin .22s ease,opacity .2s ease,padding .22s ease,border-width .22s ease}
.sbi{width:calc(var(--sbw) - 2px);flex:1;min-height:0;display:flex;flex-direction:column;padding:16px 12px 12px}
.app.sbc .sb{width:0;margin-right:calc(-1 * var(--gap));opacity:0;border-width:0;pointer-events:none}
.sbh{display:flex;align-items:center;justify-content:space-between;margin:2px 4px 16px}
.btn{height:36px;padding:0 14px;border:1px solid var(--line);background:var(--panel2);color:var(--fg);border-radius:var(--r);font-size:13px;cursor:pointer;transition:background .18s ease,border-color .18s ease;display:inline-flex;align-items:center;justify-content:center;gap:8px}
.btn:hover{background:rgba(255,255,255,.1);border-color:var(--line2)}
.btn.sm{height:30px;padding:0 12px;font-size:12px}
.btn.pri{background:var(--fg);color:#000;border-color:var(--fg)}
.btn.pri:hover{background:#fff}
.btn kbd,.pkk{font:10.5px var(--mono);color:var(--mut);border:1px solid var(--line);border-radius:5px;padding:1px 6px}
.nb{width:100%;justify-content:space-between}
.inp{width:100%;height:36px;padding:0 12px;border:1px solid var(--line);background:rgba(0,0,0,.35);border-radius:var(--r);font-size:13px;outline:none;transition:border-color .18s ease}
.inp:focus{border-color:var(--line2)}
.inp.area{height:auto;min-height:150px;padding:10px 12px;resize:vertical;line-height:1.5;font-size:13px}
#chatSearch{margin-top:10px}
.list{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:7px;margin:12px -4px 12px;padding:0 4px}
.row{position:relative;flex:none;padding:11px 13px;border-radius:var(--r);border:1px solid transparent;cursor:pointer;transition:background .18s ease,border-color .18s ease}
.row:hover{background:rgba(255,255,255,.06)}
.row.on{background:rgba(255,255,255,.1);border-color:var(--line)}
.rt{font-size:13.5px;line-height:1.35;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rt input{width:100%;background:rgba(0,0,0,.5);border:1px solid var(--line2);border-radius:7px;padding:2px 6px;font-size:13px;outline:none}
.rm{margin-top:3px;font-size:11px;color:var(--mut);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ra{position:absolute;right:7px;top:50%;transform:translateY(-50%);display:none;gap:1px;padding:2px;background:rgba(20,20,20,.96);border:1px solid var(--line);border-radius:9px}
.row:hover .ra,.row.on:focus-within .ra{display:flex}
.ra button{width:24px;height:24px;display:grid;place-items:center;border:0;background:none;color:var(--mut);border-radius:6px;cursor:pointer}
.ra button:hover{background:rgba(255,255,255,.12);color:#fff}
.ra svg,.ib svg,.cb svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.row.pin .rm::before{content:"pinned \00b7  "}
.nochats{padding:14px;color:var(--mut);font-size:12.5px;text-align:center}

/* main */
.main{flex:1;min-width:0;display:flex;flex-direction:column;position:relative;overflow:hidden}
.top{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--line);flex:none;min-height:58px}
.sp{flex:1}
.ttl{font-size:12.5px;color:var(--mut);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:36%}
.ib{width:34px;height:34px;flex:none;display:grid;place-items:center;border:1px solid transparent;background:transparent;color:var(--mut);border-radius:var(--r);cursor:pointer;transition:background .18s ease,color .18s ease}
.ib:hover{background:rgba(255,255,255,.1);color:#fff}
.pk{display:flex;align-items:center;gap:9px;height:38px;padding:0 10px;border:1px solid var(--line2);background:rgba(255,255,255,.07);border-radius:var(--r);font-size:13.5px;cursor:pointer;max-width:min(380px,62%);transition:background .18s ease,border-color .18s ease}
.pk:hover,.pk.on{background:rgba(255,255,255,.13);border-color:rgba(255,255,255,.42)}
.pkn{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.ico{width:18px;height:18px;flex:none;display:block;filter:invert(1);opacity:.92}
.icf{width:18px;height:18px;flex:none;display:grid;place-items:center;font:600 10.5px var(--mono);border:1px solid var(--line2);border-radius:5px;text-transform:uppercase;color:var(--fg)}

/* picker */
.pop{position:absolute;left:14px;top:56px;width:min(430px,calc(100% - 28px));max-height:min(580px,calc(100% - 76px));display:none;flex-direction:column;z-index:40;background:rgba(10,10,10,.92);-webkit-backdrop-filter:blur(calc(var(--blur) + 4px));backdrop-filter:blur(calc(var(--blur) + 4px));border:1px solid var(--line2);border-radius:calc(var(--r) + 2px);box-shadow:0 24px 60px rgba(0,0,0,.6)}
.pop.on{display:flex;animation:popin .16s ease}
@keyframes popin{from{opacity:0;transform:translateY(-6px)}}
.ps{padding:10px 10px 6px}
.pc{display:flex;flex-wrap:wrap;gap:6px;padding:4px 10px 10px;border-bottom:1px solid var(--line)}
.chip{height:26px;padding:0 11px;border:1px solid var(--line);background:transparent;color:var(--mut);border-radius:999px;font:11.5px var(--mono);cursor:pointer;transition:background .15s ease,color .15s ease,border-color .15s ease}
.chip:hover{color:#fff;border-color:var(--line2)}
.chip.on{background:var(--fg);color:#000;border-color:var(--fg)}
.pl{flex:1;min-height:0;overflow-y:auto;padding:6px}
.pg{padding:10px 10px 5px;font:10.5px var(--mono);letter-spacing:.14em;text-transform:uppercase;color:var(--mut2)}
.pi{display:flex;align-items:center;gap:11px;padding:8px 10px;border-radius:10px;cursor:pointer}
.pi.sel{background:rgba(255,255,255,.1)}
.pi .pn{flex:1;min-width:0;font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pi .pt{font:10.5px var(--mono);color:var(--mut2);white-space:nowrap}
.pi .ck{width:14px;color:#fff;font-size:12px;text-align:center}
.pe{padding:22px;text-align:center;color:var(--mut);font-size:13px}

/* thread */
.sc{flex:1;min-height:0;overflow-y:auto;overflow-anchor:auto;padding:22px 18px 8px}
.th{max-width:var(--cw);margin:0 auto;display:flex;flex-direction:column;gap:22px;min-width:0}
body.compact .th{gap:12px}
body.compact .bubble{padding:8px 12px}
#endAnchor{height:1px;overflow-anchor:auto}
.empty{margin:7vh auto 0;text-align:center;color:var(--mut);display:flex;flex-direction:column;align-items:center;gap:18px}
.empty svg{width:54px;height:68px}
.empty .wm{font-size:22px}
.empty p{margin:0;font-size:13.5px;max-width:380px}
.msg{display:flex;flex-direction:column;gap:6px;min-width:0}
.msg.user{align-items:flex-end}
.mm{font:11px var(--mono);color:var(--mut2);letter-spacing:.05em;padding-left:2px}
body.nomm .mm{display:none}
.bubble{min-width:0;max-width:100%;padding:11px 15px;border-radius:var(--r);font-family:var(--msgfont);font-size:var(--fs);line-height:1.62;overflow-wrap:anywhere;border:1px solid var(--line)}
.msg.user .bubble{background:rgba(255,255,255,.1);max-width:88%}
.msg.assistant .bubble{background:rgba(255,255,255,.035);width:100%}
.bubble .imgs{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:8px}
.bubble .imgs img{max-height:180px;max-width:100%;border-radius:10px;border:1px solid var(--line);display:block}
.bubble .note{font:11.5px var(--mono);color:var(--mut);margin-bottom:6px}
.err{display:none;margin-top:10px;padding:8px 12px;border:1px solid var(--line2);border-radius:10px;font:12px var(--mono);color:#ccc;white-space:pre-wrap}
.err.on{display:block}
.msg.streaming .bubble::after{content:"_";display:block;font-family:var(--mono);color:var(--mut);animation:blink 1s steps(1) infinite}
.msg.waiting .md::before{content:"...";font-family:var(--mono);color:var(--mut);animation:blink 1s steps(1) infinite}
@keyframes blink{50%{opacity:0}}
.acts{display:flex;flex-wrap:wrap;gap:2px;opacity:0;transition:opacity .15s ease}
.msg:hover .acts,.msg:focus-within .acts,.msg.cut .acts{opacity:1}
@media (hover:none){.acts{opacity:1}}
.msg.streaming .acts{opacity:0}
.acts button{background:none;border:0;color:var(--mut);padding:3px 8px;border-radius:7px;cursor:pointer;font:11.5px var(--mono);transition:background .15s ease,color .15s ease}
.acts button:hover{background:rgba(255,255,255,.1);color:#fff}
.msg:not(.cut) [data-a=continue]{display:none}
.msg.user [data-a=continue],.msg.user [data-a=regen]{display:none}
.ed{width:100%;min-height:90px;resize:vertical;padding:9px 11px;border:1px solid var(--line2);background:rgba(0,0,0,.4);border-radius:10px;font:inherit;font-size:14px;outline:none;line-height:1.5}
.edb{display:flex;gap:8px;margin-top:8px}

/* thinking */
.think{margin:0 0 10px;border:1px solid var(--line);border-radius:10px;background:rgba(255,255,255,.03);font-size:.92em}
.think summary{padding:7px 12px;cursor:pointer;color:var(--mut);font:12px var(--mono);letter-spacing:.04em;list-style:none;user-select:none}
.think summary::-webkit-details-marker{display:none}
.think summary::before{content:"+ "}
.think[open] summary::before{content:"- "}
.think.live summary{animation:blink 1.4s steps(1) infinite}
.tb{padding:2px 14px 12px;color:#9a9a9a;max-height:340px;overflow:auto}

/* markdown */
.md>*:first-child{margin-top:0}
.md>*:last-child{margin-bottom:0}
.md p{margin:0 0 .8em}
.md h1,.md h2,.md h3,.md h4,.md h5,.md h6{margin:1.1em 0 .5em;line-height:1.3;font-weight:600}
.md h1{font-size:1.5em}.md h2{font-size:1.3em}.md h3{font-size:1.15em}.md h4,.md h5,.md h6{font-size:1em}
.md ul,.md ol{margin:.2em 0 .8em;padding-left:1.5em}
.md li{margin:.2em 0}
.md li>p{margin:.2em 0}
.md li>ul,.md li>ol{margin:.2em 0 .2em}
.md li.task{list-style:none;margin-left:-1.2em}
.md li.task input{margin-right:8px;accent-color:#ddd;vertical-align:-1px}
.md blockquote{margin:.8em 0;padding:.2em 0 .2em 14px;border-left:2px solid var(--line2);color:#bdbdbd}
.md hr{border:0;border-top:1px solid var(--line);margin:1.2em 0}
.md a{color:#fff;text-decoration:underline;text-underline-offset:3px;text-decoration-color:rgba(255,255,255,.4)}
.md a:hover{text-decoration-color:#fff}
.md img{max-width:100%;border-radius:10px;display:block;margin:.5em 0}
.md code{font:var(--cfs) var(--mono);background:rgba(255,255,255,.1);padding:1px 6px;border-radius:6px;overflow-wrap:anywhere}
.md .code code{background:none;padding:0;border-radius:0;font-size:inherit;overflow-wrap:normal}
.tw{overflow-x:auto;margin:.8em 0;max-width:100%;border:1px solid var(--line);border-radius:10px}
.tw table{border-collapse:collapse;width:100%;font-size:.93em}
.tw th,.tw td{padding:8px 12px;border-bottom:1px solid var(--line);border-right:1px solid var(--line);text-align:left;vertical-align:top;word-break:normal;overflow-wrap:normal;hyphens:none;min-width:64px}
.tw th{background:rgba(255,255,255,.06);font-weight:600;white-space:nowrap}
.tw tr:last-child td{border-bottom:0}
.tw th:last-child,.tw td:last-child{border-right:0}
.tw::-webkit-scrollbar{width:11px;height:11px}
.tw::-webkit-scrollbar-track{background:rgba(255,255,255,.06)}
.tw::-webkit-scrollbar-thumb{background:#6a6a6a;border-radius:6px;border:2px solid transparent;background-clip:padding-box}
.tw{scrollbar-width:auto;scrollbar-color:#6a6a6a rgba(255,255,255,.06)}

/* code blocks */
.code{margin:.8em 0;border:1px solid var(--line);border-radius:10px;background:rgba(0,0,0,.45);overflow:hidden;max-width:100%}
.ch{display:flex;align-items:center;gap:6px;padding:5px 8px 5px 12px;border-bottom:1px solid var(--line);background:rgba(255,255,255,.04);font:11.5px var(--mono);color:var(--mut)}
.ch .sp{flex:1}
.ch button{background:none;border:1px solid transparent;color:var(--mut);padding:2px 9px;border-radius:7px;cursor:pointer;font:inherit;transition:background .15s ease,color .15s ease}
.ch button:hover{background:rgba(255,255,255,.1);color:#fff}
.code pre{margin:0;padding:12px 14px;overflow:auto;max-height:520px;font:var(--cfs)/1.55 var(--mono);tab-size:2;white-space:pre;scrollbar-width:auto;scrollbar-color:#6a6a6a rgba(255,255,255,.06)}
.code.flip pre{white-space:pre-wrap;overflow-wrap:anywhere}
body.wrapcode .code pre{white-space:pre-wrap;overflow-wrap:anywhere}
body.wrapcode .code.flip pre{white-space:pre;overflow-wrap:normal}
.code pre::-webkit-scrollbar{width:11px;height:11px}
.code pre::-webkit-scrollbar-track{background:rgba(255,255,255,.06)}
.code pre::-webkit-scrollbar-thumb{background:#6a6a6a;border-radius:6px;border:2px solid transparent;background-clip:padding-box}
.code pre::-webkit-scrollbar-corner{background:transparent}
.code code{font:inherit}
.cm{color:#6f6f6f;font-style:italic}
.st{color:#c4c4c4}
.kw{color:#fff;font-weight:700}
.nu{color:#e2e2e2}
.fn{color:#fff;border-bottom:1px dotted rgba(255,255,255,.35)}
.ty{color:#bdbdbd;font-weight:600}
.pr{color:#9c9c9c}
.da{color:#fff;font-weight:600}
.dd{color:#777;text-decoration:line-through}
.dh{color:#aaa;font-style:italic}
body.colored .cm{color:#6a9955}
body.colored .st{color:#ce9178}
body.colored .kw{color:#c586c0}
body.colored .nu{color:#b5cea8}
body.colored .fn{color:#dcdcaa;border-bottom:0}
body.colored .ty{color:#4ec9b0}
body.colored .pr{color:#9cdcfe}
body.colored .da{color:#7ec17e}
body.colored .dd{color:#e06c75}
body.colored .dh{color:#61afef}

/* composer */
.cp{flex:none;padding:8px 18px 16px;position:relative}
.cpi{max-width:var(--cw);margin:0 auto;position:relative}
.tray{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:8px}
.tray:empty{display:none}
.at{position:relative;height:56px;border:1px solid var(--line);border-radius:10px;overflow:hidden;display:flex;align-items:center;background:var(--panel2)}
.at img{height:100%;display:block}
.at span{padding:0 30px 0 12px;font:12px var(--mono);max-width:200px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.at button{position:absolute;top:3px;right:3px;width:18px;height:18px;display:grid;place-items:center;border:0;border-radius:50%;background:rgba(0,0,0,.7);color:#fff;font-size:11px;cursor:pointer;line-height:1}
.crow{display:flex;align-items:flex-end;gap:8px}
.cb{width:40px;height:40px;flex:none;display:grid;place-items:center;border:1px solid var(--line2);background:rgba(10,10,10,.7);color:var(--fg);border-radius:var(--ctl-r);cursor:pointer;transition:background .18s ease,border-color .18s ease,opacity .18s ease}
.cb:hover{background:rgba(255,255,255,.12)}
.cb.send{background:var(--fg);color:#000;border-color:var(--fg)}
.cb.send:hover{background:#fff}
.cb.send.idle{opacity:.4}
#ta{flex:1;min-width:0;display:block;height:40px;min-height:40px;max-height:220px;padding:9px 16px;border:1px solid var(--line2);background:rgba(10,10,10,.7);border-radius:var(--ctl-r);font-family:var(--sans);font-size:15px;line-height:22px;resize:none;outline:none;overflow-y:hidden;transition:border-color .18s ease}
#ta:focus{border-color:rgba(255,255,255,.45)}
#ta::placeholder{color:var(--mut2);line-height:22px}
.jb{position:absolute;left:50%;bottom:calc(100% + 10px);transform:translateX(-50%);display:none;height:30px;padding:0 14px;border:1px solid var(--line2);background:rgba(10,10,10,.85);border-radius:999px;font:11.5px var(--mono);cursor:pointer}
.jb.on{display:block}
.jb:hover{background:rgba(40,40,40,.95)}
.drop{position:absolute;inset:10px;z-index:45;display:none;place-items:center;border:1px dashed var(--line2);border-radius:var(--r);background:rgba(0,0,0,.65);font:13px var(--mono);color:var(--fg)}
.main.dragging .drop{display:grid}

/* modal */
.mod{position:fixed;inset:0;z-index:100;display:none;place-items:center;background:rgba(0,0,0,.55)}
.mod.on{display:grid}
.mb{width:min(720px,calc(100% - 24px));max-height:calc(100% - 40px);display:flex;flex-direction:column;background:rgba(12,12,12,.94);-webkit-backdrop-filter:blur(var(--blur));backdrop-filter:blur(var(--blur));border:1px solid var(--line2);border-radius:calc(var(--r) + 4px);box-shadow:0 30px 80px rgba(0,0,0,.7)}
.mh{display:flex;align-items:center;gap:14px;padding:12px 14px 12px 18px;border-bottom:1px solid var(--line)}
.mt{font:500 13px var(--mono);letter-spacing:.2em}
.tabs{display:flex;gap:4px;flex:1;flex-wrap:wrap}
.tab{height:30px;padding:0 13px;border:1px solid transparent;background:transparent;color:var(--mut);border-radius:999px;font:12px var(--mono);cursor:pointer}
.tab:hover{color:#fff}
.tab.on{border-color:var(--line2);color:#fff;background:rgba(255,255,255,.08)}
.mbody{flex:1;min-height:0;overflow-y:auto;padding:6px 18px 18px}
.fl{display:flex;align-items:center;justify-content:space-between;gap:18px;padding:12px 0;border-bottom:1px solid var(--line)}
.fl.col{flex-direction:column;align-items:stretch;gap:10px}
.fll{min-width:0}
.flt{font-size:13.5px}
.flh{font-size:11.5px;color:var(--mut);margin-top:2px}
.rg{display:flex;align-items:center;gap:12px}
.rg .val{font:12px var(--mono);color:var(--mut);min-width:54px;text-align:right}
input[type=range]{width:190px;accent-color:#ddd}
.fl select,.fl input[type=number],.fl input[type=text]{height:34px;padding:0 10px;border:1px solid var(--line2);background:rgba(0,0,0,.4);border-radius:var(--r);font-size:13px;outline:none;max-width:260px}
.fl select option{background:#111}
.tg{position:relative;width:40px;height:22px;flex:none;display:block;cursor:pointer}
.tg input{position:absolute;opacity:0;inset:0;cursor:pointer;margin:0}
.tg i{position:absolute;inset:0;border:1px solid var(--line2);border-radius:999px;background:rgba(255,255,255,.06);transition:background .18s ease}
.tg i::after{content:"";position:absolute;top:3px;left:3px;width:14px;height:14px;border-radius:50%;background:#aaa;transition:transform .18s ease,background .18s ease}
.tg input:checked+i{background:var(--fg)}
.tg input:checked+i::after{transform:translateX(18px);background:#000}
.dbtn{display:flex;flex-direction:column;align-items:flex-start;gap:4px}
.toast{position:fixed;left:50%;bottom:26px;z-index:300;transform:translate(-50%,16px);padding:9px 18px;border:1px solid var(--line2);background:rgba(12,12,12,.94);border-radius:999px;font:12.5px var(--mono);opacity:0;pointer-events:none;transition:opacity .2s ease,transform .2s ease}
.toast.on{opacity:1;transform:translate(-50%,0)}

body.noanim *,body.noanim *::before,body.noanim *::after{transition:none!important;animation:none!important}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{transition:none!important;animation:none!important}}
@media (max-width:800px){
  .sb{position:absolute;left:var(--gap);top:var(--gap);bottom:var(--gap);z-index:60;background:rgba(10,10,10,.94)}
  .app.sbc .sb{margin-right:0;left:calc(-1 * var(--sbw) - 20px)}
  .ttl{display:none}
  .pkk{display:none}
  input[type=range]{width:130px}
  .fl{flex-wrap:wrap}
}
`;

const GAL_BODY = String.raw`
<canvas id="art" aria-hidden="true"></canvas>
<canvas id="trail" aria-hidden="true"></canvas>
<div class="app" id="app">
  <aside class="sb glass" id="sb"><div class="sbi">
    <div class="sbh">
      <div class="logo" id="logoS">${markSvg("mk")}<span class="wm" id="wmS">gallium</span></div>
      <button class="ib" id="sbClose" title="collapse sidebar" aria-label="collapse sidebar"><svg viewBox="0 0 24 24"><path d="M15 6l-6 6 6 6"/></svg></button>
    </div>
    <button class="btn nb" id="newChat"><span>+ new chat</span><kbd>alt n</kbd></button>
    <input class="inp" id="chatSearch" type="text" placeholder="search chats" autocomplete="off" spellcheck="false">
    <div class="list" id="list"></div>
    <button class="btn" id="openSet">settings</button>
  </div></aside>

  <main class="main glass" id="main">
    <div class="top">
      <button class="pk" id="pk" title="choose model (ctrl+k)" aria-haspopup="listbox"><span id="pkIcon"></span><span class="pkn" id="pkName">model</span><span class="pkk">ctrl k</span></button>
      <div class="sp"></div>
      <div class="ttl" id="ttl"></div>
      <button class="ib" id="sbOpen" title="toggle sidebar" aria-label="toggle sidebar"><svg viewBox="0 0 24 24"><rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M9.5 4.5v15"/></svg></button>
    </div>

    <div class="pop" id="pop" role="listbox">
      <div class="ps"><input class="inp" id="pq" type="text" placeholder="search models" autocomplete="off" spellcheck="false"></div>
      <div class="pc" id="pc"></div>
      <div class="pl" id="pl"></div>
    </div>

    <div class="sc" id="sc"><div class="th" id="th"></div><div id="endAnchor"></div></div>

    <div class="cp">
      <div class="cpi">
        <button class="jb" id="jb">&darr; latest</button>
        <div class="tray" id="tray"></div>
        <div class="crow">
          <button class="cb" id="attach" title="attach files" aria-label="attach files"><svg viewBox="0 0 24 24"><path d="M20 11.5l-8.2 8.2a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8"/></svg></button>
          <textarea id="ta" rows="1" placeholder="message gallium" spellcheck="false"></textarea>
          <button class="cb send idle" id="send" title="send" aria-label="send"></button>
        </div>
        <input type="file" id="file" multiple hidden>
      </div>
    </div>
    <div class="drop">drop files to attach</div>
  </main>
</div>

<div class="mod" id="mod">
  <div class="mb" role="dialog" aria-label="settings">
    <div class="mh"><div class="mt">settings</div><div class="tabs" id="tabs"></div><button class="ib" id="modX" aria-label="close"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
    <div class="mbody" id="mbody"></div>
  </div>
</div>
<input type="file" id="imp" accept="application/json,.json" hidden>
<div class="toast" id="toast"></div>
`;

/* ============================== GALLIUM APP: JS PART 1 (state, models, markdown, highlighter) ============================== */

const GAL_JS1 = String.raw`(function(){
"use strict";
var $=function(s,r){return (r||document).querySelector(s)};
var $$=function(s,r){return Array.prototype.slice.call((r||document).querySelectorAll(s))};
var INIT_MODELS=__INITIAL_MODELS__;
var F3=String.fromCharCode(96,96,96),F4=String.fromCharCode(96,96,96,96);
var DEFAULT_SYS="You are gallium, a senior software engineer and coding assistant. Be direct and concise. Use fenced code blocks with a language tag. Always write complete, working code and never truncate files or leave placeholders.";
var CONT_PROMPT="Continue exactly where you stopped. Do not repeat anything and do not add any preface.";
var ICON_BASE="https://cdn.jsdelivr.net/npm/@lobehub/icons-static-svg@latest/icons/";
var DEFAULTS={sys:DEFAULT_SYS,temp:.7,topp:1,maxtok:16384,effort:"medium",autocont:true,thinkopen:false,entersend:true,
 fs:15,cfs:13,cw:820,mfont:"sans",wrap:false,colored:false,showmodel:true,blur:18,glass:62,r:14,anim:true,sbw:280,compact:false,
 art:true,artb:40,arts:100,artcell:9,trail:true,trailn:50,trails:14,traill:900,trailchars:"#-+*=.:/\\|~^ox%<>[]{}()01",
 model:"g:llama-3.3-70b-versatile"};

var state={settings:Object.assign({},DEFAULTS),chats:[],cur:null,ui:{sb:true}};

function uid(){return Math.random().toString(36).slice(2,9)+Date.now().toString(36).slice(-4)}
function esc(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;")}
function clamp(v,a,b){return v<a?a:v>b?b:v}
function smooth(a,b,x){x=clamp((x-a)/(b-a),0,1);return x*x*(3-2*x)}
function toast(msg){var t=$("#toast");t.textContent=msg;t.classList.add("on");clearTimeout(toast.t);toast.t=setTimeout(function(){t.classList.remove("on")},2300)}
function rel(t){
  var s=(Date.now()-t)/1000;
  if(s<60)return "just now";
  if(s<3600)return Math.floor(s/60)+"m ago";
  if(s<86400)return Math.floor(s/3600)+"h ago";
  if(s<604800)return Math.floor(s/86400)+"d ago";
  return new Date(t).toLocaleDateString();
}
function copyText(t){
  function fb(){
    var a=document.createElement("textarea");a.value=t;a.style.cssText="position:fixed;opacity:0;top:0";
    document.body.appendChild(a);a.select();try{document.execCommand("copy")}catch(e){}a.remove();
  }
  if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(t).catch(fb)}else fb();
}

/* ---------- persistence ---------- */
var saveT=0;
function saveSoon(){clearTimeout(saveT);saveT=setTimeout(saveNow,400)}
function snapshot(dropReasoning,chats){
  return {v:1,settings:state.settings,cur:state.cur,ui:state.ui,chats:(chats||state.chats).map(function(c){
    var o=Object.assign({},c);
    o.messages=c.messages.map(function(m){
      var x=Object.assign({},m);
      if(x.images&&x.images.length)x.imgCount=x.images.length;
      x.images=[];delete x.streaming;
      if(dropReasoning)delete x.reasoning;
      return x;
    });
    return o;
  })};
}
function saveNow(){
  try{localStorage.setItem("gallium_state",JSON.stringify(snapshot(false)));return}catch(e){}
  try{localStorage.setItem("gallium_state",JSON.stringify(snapshot(true)));return}catch(e){}
  var list=state.chats.slice().sort(function(a,b){return (b.pinned?1:0)-(a.pinned?1:0)||b.updated-a.updated});
  while(list.length>1){
    var victim=null;
    for(var i=list.length-1;i>=0;i--){if(!list[i].pinned&&list[i].id!==state.cur){victim=i;break}}
    if(victim===null)break;
    list.splice(victim,1);
    try{localStorage.setItem("gallium_state",JSON.stringify(snapshot(true,list)));toast("storage full: older chats not saved");return}catch(e){}
  }
  toast("could not save (storage full)");
}
function loadState(){
  try{
    var j=JSON.parse(localStorage.getItem("gallium_state")||"null");
    if(j&&typeof j==="object"){
      state.settings=Object.assign({},DEFAULTS,j.settings||{});
      state.chats=Array.isArray(j.chats)?j.chats.filter(function(c){return c&&typeof c==="object"}):[];
      state.cur=j.cur||null;
      state.ui=Object.assign({sb:true},j.ui||{});
    }
  }catch(e){}
  state.chats.forEach(function(c){
    c.id=c.id||uid();c.title=c.title||"New chat";c.created=c.created||Date.now();c.updated=c.updated||c.created;
    c.messages=(Array.isArray(c.messages)?c.messages:[]).filter(function(m){return m&&typeof m==="object"});
    c.messages.forEach(function(m){
      m.id=m.id||uid();m.images=[];m.content=typeof m.content==="string"?m.content:"";
      if(m.streaming){m.cut=true}
      m.streaming=false;
    });
  });
}

/* ---------- models: brand, category, rank ---------- */
var models=INIT_MODELS.slice();
var metaCache={};
var BRANDS=[[/gpt|openai|chatgpt|^o[134](-|$)/,"openai"],[/claude/,"anthropic"],[/gemini|gemma/,"google"],[/deepseek/,"deepseek"],[/grok/,"xai"],
 [/mistral|mixtral|codestral|devstral|pixtral|ministral|magistral/,"mistral"],[/qwen|qwq/,"qwen"],[/kimi|moonshot/,"moonshot"],[/glm|zhipu/,"zhipu"],
 [/llama/,"meta"],[/perplexity|sonar/,"perplexity"],[/phi-/,"microsoft"],[/nova/,"aws"],[/minimax/,"minimax"]];
var FAM={anthropic:"claude",google:"gemini",xai:"grok",meta:"llama",moonshot:"kimi",zhipu:"glm",openai:"gpt"};
var RANK=[/claude-large|opus/,/claude|sonnet/,/openai-large|gpt-5|gpt-4\.1/,/gpt-oss-120b/,/gemini/,/deepseek/,/kimi/,/llama-4|llama-3\.3-70b/,/qwen/,/grok/,/glm/,/mistral/,/^openai$/,/gpt-oss-20b/];
var CAT_ORDER=["coding","reasoning","agentic","general","fast"];
function modelName(id){
  for(var i=0;i<models.length;i++)if(models[i].id===id)return models[i].name;
  return String(id||"").slice(2).split("/").pop()||"model";
}
function metaOf(m){
  if(metaCache[m.id])return metaCache[m.id];
  var n=m.name.toLowerCase(),cats=[],brand=null,i,rank=99;
  for(i=0;i<BRANDS.length;i++)if(BRANDS[i][0].test(n)){brand=BRANDS[i][1];break}
  if(/coder|code|codestral|devstral/.test(n))cats.push("coding");
  if(/r1|reason|thinking|gpt-oss|qwen3|qwq|deepseek|^o[134](-|$)|perplexity|magistral/.test(n))cats.push("reasoning");
  if(/kimi|glm|grok|claude|large|120b|maverick|gpt-5|agent|deepseek/.test(n))cats.push("agentic");
  if(/fast|mini|nano|flash|instant|8b|small|lite|scout|20b|haiku|turbo/.test(n))cats.push("fast");
  if(!cats.length||(cats.length===1&&cats[0]==="fast"))cats.push("general");
  if(m.vision||/vision|scout|maverick|gemini|^openai|claude|llama-4|pixtral|-vl/.test(n))cats.push("vision");
  var primary="general";
  for(i=0;i<CAT_ORDER.length;i++)if(cats.indexOf(CAT_ORDER[i])>=0){primary=CAT_ORDER[i];break}
  for(i=0;i<RANK.length;i++)if(RANK[i].test(n)){rank=i;break}
  var family=brand?(FAM[brand]||brand):n.split(/[-_.\d]/)[0]||"other";
  return metaCache[m.id]={brand:brand,cats:cats,primary:primary,rank:rank,family:family};
}
function iconHtml(m){
  var me=metaOf(m),l=esc(m.name.charAt(0)||"?");
  if(me.brand)return '<img class="ico" data-l="'+l+'" src="'+ICON_BASE+me.brand+'.svg" alt="">';
  return '<span class="icf">'+l+"</span>";
}
document.addEventListener("error",function(e){
  var t=e.target;
  if(t&&t.classList&&t.classList.contains("ico")){
    var s=document.createElement("span");s.className="icf";s.textContent=t.getAttribute("data-l")||"?";
    t.replaceWith(s);
  }
},true);

/* ---------- markdown ---------- */
var FENCE_RE=/^\s*(\u0060{3,}|~{3,})\s*([^\s\u0060]*)[^\n]*$/;
var CLOSE_RE=/^\s*(\u0060{3,}|~{3,})\s*$/;
var HR_RE=/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
var LIST_RE=/^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
var SEP_RE=/^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
var CODE_RE=/(\u0060+)([\s\S]*?[^\u0060])\1(?!\u0060)/g;
function safeUrl(u){return /^(https?:|mailto:|data:image\/|\/|#)/i.test(u)}
function emph(s){
  s=s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g,"<strong>$1</strong>");
  s=s.replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g,"$1<strong>$2</strong>");
  s=s.replace(/(^|[^*\w])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?!\*)/g,"$1<em>$2</em>");
  s=s.replace(/(^|[^\w])_(?=[^\s_])([^_\n]*?[^\s_])_(?!\w)/g,"$1<em>$2</em>");
  s=s.replace(/~~(?=\S)([\s\S]*?\S)~~/g,"<del>$1</del>");
  return s;
}
function inl(s){
  var st=[];
  function put(h){st.push(h);return "\u0001"+(st.length-1)+"\u0002"}
  s=s.replace(CODE_RE,function(m,a,b){return put("<code>"+esc(b.replace(/^ (.*) $/,"$1"))+"</code>")});
  s=esc(s);
  s=s.replace(/&lt;br\s*\/?&gt;/gi,"<br>");
  s=s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^)]*?&quot;)?\)/g,function(m,a,u){return safeUrl(u)?put('<img alt="'+a+'" src="'+u+'" loading="lazy">'):m});
  s=s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^)]*?&quot;)?\)/g,function(m,t,u){return safeUrl(u)?put('<a href="'+u+'" target="_blank" rel="noopener noreferrer">'+emph(t)+"</a>"):m});
  s=s.replace(/(^|[\s(>])(https?:\/\/[^\s<]*[^\s<.,;:!?)\]'"])/g,function(m,p,u){return p+put('<a href="'+u+'" target="_blank" rel="noopener noreferrer">'+u+"</a>")});
  s=emph(s);
  for(var k=0;k<3&&/\u0001\d+\u0002/.test(s);k++)s=s.replace(/\u0001(\d+)\u0002/g,function(m,i){return st[+i]});
  return s;
}
function splitRow(s){
  s=s.trim();
  var ends=/\|\s*$/.test(s)&&!/\\\|\s*$/.test(s);
  if(s.charAt(0)==="|")s=s.slice(1);
  var cells=[],cur="",k,c;
  for(k=0;k<s.length;k++){
    c=s.charAt(k);
    if(c==="\\"&&s.charAt(k+1)==="|"){cur+="|";k++}
    else if(c==="|"){cells.push(cur);cur=""}
    else cur+=c;
  }
  cells.push(cur);
  if(ends&&cells.length&&cells[cells.length-1].trim()==="")cells.pop();
  return cells.map(function(x){return x.trim()});
}
function blockStart(lines,i){
  var l=lines[i];
  return FENCE_RE.test(l)||/^\s{0,3}#{1,6}\s/.test(l)||/^\s{0,3}>/.test(l)||HR_RE.test(l)||LIST_RE.test(l)||(l.indexOf("|")>=0&&i+1<lines.length&&SEP_RE.test(lines[i+1]));
}
function codeBlock(code,lang){
  var l=(lang||"").toLowerCase().replace(/[^a-z0-9#+.\-]/g,"");
  return '<div class="code" data-lang="'+esc(l)+'"><div class="ch"><span class="lang">'+(esc(l)||"text")+'</span><span class="sp"></span><button data-act="wrap" type="button">wrap</button><button data-act="copy" type="button">copy</button></div><pre><code>'+hl(code,l)+"</code></pre></div>";
}
function mdList(lines){
  var first=LIST_RE.exec(lines[0]),base=first[1].length,ord=/\d/.test(first[2]),start=ord?parseInt(first[2],10):1,items=[],cur=null,k,m;
  for(k=0;k<lines.length;k++){
    m=LIST_RE.exec(lines[k]);
    if(m&&m[1].length<=base+1){cur={t:m[3],sub:[]};items.push(cur)}
    else if(cur){cur.sub.push(lines[k])}
  }
  var h=(ord?"<ol"+(start!==1?' start="'+start+'"':""):"<ul")+">";
  items.forEach(function(it){
    var t=it.t,task=/^\[( |x|X)\]\s+/.exec(t),pre="";
    if(task){pre='<input type="checkbox" disabled'+(task[1]!==" "?" checked":"")+"> ";t=t.slice(task[0].length)}
    var inner=inl(t),sub=it.sub;
    if(sub.length){
      var mi=1e9;
      sub.forEach(function(s){if(s.trim()){var ind=/^\s*/.exec(s)[0].length;if(ind<mi)mi=ind}});
      sub=sub.map(function(s){return s.slice(Math.min(mi,/^\s*/.exec(s)[0].length))});
      inner+=mdBlocks(sub.join("\n")).join("");
    }
    h+="<li"+(task?' class="task"':"")+">"+pre+inner+"</li>";
  });
  return h+(ord?"</ol>":"</ul>");
}
function mdBlocks(src){
  var lines=String(src).replace(/\r\n?/g,"\n").split("\n"),out=[],i=0,n=lines.length,m;
  while(i<n){
    var line=lines[i];
    if(/^\s*$/.test(line)){i++;continue}
    if((m=FENCE_RE.exec(line))){
      var ch=m[1].charAt(0),len=m[1].length,lang=m[2],buf=[];
      i++;
      while(i<n){
        var cm=CLOSE_RE.exec(lines[i]);
        if(cm&&cm[1].charAt(0)===ch&&cm[1].length>=len){i++;break}
        buf.push(lines[i]);i++;
      }
      out.push(codeBlock(buf.join("\n"),lang));
      continue;
    }
    if((m=/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line))){
      var lv=m[1].length;
      out.push("<h"+lv+">"+inl(m[2])+"</h"+lv+">");i++;continue;
    }
    if(HR_RE.test(line)){out.push("<hr>");i++;continue}
    if(/^\s{0,3}>/.test(line)){
      var q=[];
      while(i<n&&/^\s{0,3}>/.test(lines[i])){q.push(lines[i].replace(/^\s{0,3}>\s?/,""));i++}
      out.push("<blockquote>"+mdBlocks(q.join("\n")).join("")+"</blockquote>");
      continue;
    }
    if(line.indexOf("|")>=0&&i+1<n&&SEP_RE.test(lines[i+1])){
      var hdr=splitRow(line),al=splitRow(lines[i+1]).map(function(c){var l=c.charAt(0)===":",r=c.charAt(c.length-1)===":";return l&&r?"center":r?"right":l?"left":""});
      i+=2;
      var rows=[];
      while(i<n&&lines[i].indexOf("|")>=0&&!/^\s*$/.test(lines[i])&&!FENCE_RE.test(lines[i])){rows.push(splitRow(lines[i]));i++}
      var t='<div class="tw"><table><thead><tr>';
      hdr.forEach(function(c,k){t+="<th"+(al[k]?' style="text-align:'+al[k]+'"':"")+">"+inl(c)+"</th>"});
      t+="</tr></thead><tbody>";
      rows.forEach(function(r){
        t+="<tr>";
        for(var k=0;k<hdr.length;k++)t+="<td"+(al[k]?' style="text-align:'+al[k]+'"':"")+">"+inl(r[k]||"")+"</td>";
        t+="</tr>";
      });
      out.push(t+"</tbody></table></div>");
      continue;
    }
    if(LIST_RE.test(line)){
      var lb=[];
      while(i<n){
        var l=lines[i];
        if(/^\s*$/.test(l)){
          var j=i+1;
          while(j<n&&/^\s*$/.test(lines[j]))j++;
          if(j<n&&!HR_RE.test(lines[j])&&(LIST_RE.test(lines[j])||/^\s{2,}\S/.test(lines[j]))){lb.push(l);i++;continue}
          break;
        }
        if(HR_RE.test(l))break;
        if(LIST_RE.test(l)||/^\s{2,}\S/.test(l)){lb.push(l);i++;continue}
        break;
      }
      out.push(mdList(lb));
      continue;
    }
    var pb=[line];
    i++;
    while(i<n&&!/^\s*$/.test(lines[i])&&!blockStart(lines,i)){pb.push(lines[i]);i++}
    out.push("<p>"+inl(pb.join("\n")).replace(/\n/g,"<br>")+"</p>");
  }
  return out;
}
function patch(el,blocks){
  var ch=el.children,i;
  for(i=0;i<blocks.length;i++){
    var c=ch[i];
    if(c&&c.__h===blocks[i])continue;
    var t=document.createElement("template");
    t.innerHTML=blocks[i];
    var nn=t.content.firstElementChild;
    if(!nn)continue;
    nn.__h=blocks[i];
    if(c)el.replaceChild(nn,c);else el.appendChild(nn);
  }
  while(el.children.length>blocks.length)el.removeChild(el.lastChild);
}

/* ---------- syntax highlighter (no libraries) ---------- */
var R_DQ=/"(?:\\.|[^"\\\n])*"?/,R_SQ=/'(?:\\.|[^'\\\n])*'?/,R_BT=/\u0060(?:\\[\s\S]|[^\u0060\\])*\u0060?/;
var R_NUM=/\b(?:0[xX][0-9a-fA-F_]+|\d[\d_]*\.?\d*(?:[eE][+-]?\d+)?)\b/;
var R_FN=/\b[A-Za-z_$][\w$]*(?=\s*\()/,R_TY=/\b[A-Z][A-Za-z0-9_]*\b/;
var R_LC=/\/\/[^\n]*/,R_BC=/\/\*[\s\S]*?(?:\*\/|(?![\s\S]))/;
function alt(){var s=[],i;for(i=0;i<arguments.length;i++)s.push(arguments[i].source);return new RegExp(s.join("|"))}
function kwre(s){return new RegExp("\\b(?:"+s.split(" ").join("|")+")\\b")}
var JS_KW="break case catch class const continue debugger default delete do else export extends finally for from function if import in instanceof let new of return static super switch this throw try typeof var void while with yield async await null true false undefined interface type enum implements public private protected readonly as declare namespace abstract get set";
var PY_KW="and as assert async await break class continue def del elif else except finally for from global if import in is lambda None nonlocal not or pass raise return try while with yield True False self";
var SH_KW="if then else elif fi for while do done case esac function in select until return exit local export readonly source unset";
var SH_CMD="echo cd ls cat grep sed awk curl wget npm npx yarn pnpm git docker sudo apt pip pip3 python python3 node make mkdir rm cp mv chmod chown touch tar unzip ssh kill ps";
var SQL_KW="select from where and or not null insert into values update set delete create table drop alter add column index primary key foreign references join left right inner outer full cross on group by order having limit offset distinct as in is like between exists case when then else end union all asc desc count sum avg min max with over partition view database default unique check constraint begin commit rollback transaction int integer varchar text boolean date timestamp serial returning";
var GO_KW="break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var nil true false iota";
var GO_TY="int int8 int16 int32 int64 uint uint8 uint16 uint32 uint64 uintptr float32 float64 complex64 complex128 string bool byte rune error any";
var RS_KW="as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while";
var RS_TY="i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64 bool str char String Vec Option Result Box";
var CL_KW="abstract as async await break case catch class const constexpr continue default delete do else enum explicit export extends extern false final finally for foreach friend fun goto if implements import in inline instanceof interface internal is lambda namespace new null nullptr object operator override package private protected public readonly ref return sealed sizeof static struct super switch template this throw throws trait true try typedef typeof union unsafe using val var virtual void volatile when where while yield get set";
var CL_TY="int long short byte char float double bool boolean void string String auto unsigned signed size_t Int Long Double Float Boolean Unit Any";
var PHP_KW="abstract and array as break callable case catch class clone const continue declare default do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile extends final finally fn for foreach function global if implements include include_once instanceof interface isset list match namespace new or print private protected public readonly require require_once return static switch throw trait try unset use var while yield null true false";
var RULES={
 js:function(){return [["cm",alt(R_LC,R_BC)],["st",alt(R_DQ,R_SQ,R_BT)],["nu",R_NUM],["kw",kwre(JS_KW)],["fn",R_FN],["ty",R_TY]]},
 py:function(){return [["cm",/#[^\n]*/],["st",/[rRbBfFuU]{0,2}(?:"""[\s\S]*?(?:"""|(?![\s\S]))|'''[\s\S]*?(?:'''|(?![\s\S]))|"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?)/],["fn",/@[\w.]+/],["nu",R_NUM],["kw",kwre(PY_KW)],["fn",R_FN],["ty",R_TY]]},
 sh:function(){return [["pr",/\$(?:\{[^}\n]*\}|[A-Za-z_]\w*|[0-9@#?*!$-])/],["cm",/(?:^|\s)#[^\n]*/],["st",alt(R_DQ,R_SQ)],["nu",R_NUM],["kw",kwre(SH_KW)],["fn",kwre(SH_CMD)],["pr",/(?:^|\s)--?[A-Za-z][\w-]*/]]},
 json:function(){return [["pr",/"(?:\\.|[^"\\\n])*"(?=\s*:)/],["st",R_DQ],["nu",/-?\b\d+\.?\d*(?:[eE][+-]?\d+)?\b/],["kw",/\b(?:true|false|null)\b/]]},
 html:function(){return [["cm",/<!\x2d\x2d[\s\S]*?(?:\x2d\x2d>|(?![\s\S]))/],["st",/"[^"\n]*"|'[^'\n]*'/],["kw",/<\/?[A-Za-z][\w:.-]*|\/?>/],["pr",/[A-Za-z_:][\w:.-]*(?==)/]]},
 css:function(){return [["cm",R_BC],["st",alt(R_DQ,R_SQ)],["kw",/@[\w-]+/],["nu",/#[0-9a-fA-F]{3,8}\b|-?(?:\d+\.?\d*|\.\d+)(?:%|(?:px|r?em|vh|vw|vmin|vmax|ms|s|deg|fr|ch)\b)?/],["pr",/[\w-]+(?=\s*:(?!:))/],["ty",/[.#][A-Za-z_][\w-]*/],["fn",R_FN]]},
 sql:function(){return [["cm",/--[^\n]*|\/\*[\s\S]*?(?:\*\/|(?![\s\S]))/],["st",alt(R_SQ,R_DQ)],["nu",R_NUM],["kw",kwre(SQL_KW)],["fn",R_FN]]},
 yaml:function(){return [["cm",/#[^\n]*/],["pr",/^[ \t-]*[\w."'\/-]+(?=\s*:(?:\s|$))/],["st",alt(R_DQ,R_SQ)],["nu",R_NUM],["kw",/\b(?:true|false|null|yes|no)\b|~/],["ty",/[&*][\w-]+/]]},
 go:function(){return [["cm",alt(R_LC,R_BC)],["st",alt(R_DQ,R_BT,/'(?:\\.|[^'\\\n])'/)],["nu",R_NUM],["kw",kwre(GO_KW)],["ty",kwre(GO_TY)],["fn",R_FN],["ty",R_TY]]},
 rust:function(){return [["cm",alt(R_LC,R_BC)],["st",alt(R_DQ,/'(?:\\.|[^'\\\n])'/)],["ty",/'[A-Za-z_]\w*\b/],["nu",R_NUM],["kw",kwre(RS_KW)],["fn",/\b\w+!(?=[(\[{])/],["fn",R_FN],["ty",kwre(RS_TY)],["ty",R_TY]]},
 clike:function(){return [["cm",alt(R_LC,R_BC)],["kw",/^[ \t]*#[ \t]*\w+/],["fn",/@[A-Za-z_]\w*/],["st",alt(R_DQ,R_SQ)],["nu",/\b(?:0[xX][0-9a-fA-F_]+|\d[\d_]*\.?\d*(?:[eE][+-]?\d+)?)[fFlLuU]*\b/],["kw",kwre(CL_KW)],["ty",kwre(CL_TY)],["fn",R_FN],["ty",R_TY]]},
 php:function(){return [["cm",/\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?(?:\*\/|(?![\s\S]))/],["kw",/<\?php|<\?=|\?>/],["pr",/\$[A-Za-z_]\w*/],["st",alt(R_DQ,R_SQ)],["nu",R_NUM],["kw",kwre(PHP_KW)],["fn",R_FN],["ty",R_TY]]}
};
var ALIAS={js:"js",javascript:"js",mjs:"js",cjs:"js",jsx:"js",ts:"js",tsx:"js",typescript:"js",node:"js",
 py:"py",python:"py",sh:"sh",bash:"sh",shell:"sh",zsh:"sh",console:"sh",
 json:"json",jsonc:"json",html:"html",xml:"html",svg:"html",vue:"html",xhtml:"html",htm:"html",
 css:"css",scss:"css",less:"css",sql:"sql",yaml:"yaml",yml:"yaml",toml:"yaml",go:"go",golang:"go",rust:"rust",rs:"rust",
 java:"clike",kotlin:"clike",kt:"clike","c#":"clike",cs:"clike",csharp:"clike",c:"clike",cpp:"clike","c++":"clike",cc:"clike",h:"clike",hpp:"clike",swift:"clike",scala:"clike",dart:"clike",
 php:"php",diff:"diff",patch:"diff"};
var LANGS={};
function hlDiff(code){
  return code.split("\n").map(function(l){
    if(/^\+\+\+|^---|^diff |^index /.test(l))return '<span class="dh">'+esc(l)+"</span>";
    if(/^\+/.test(l))return '<span class="da">'+esc(l)+"</span>";
    if(/^-/.test(l))return '<span class="dd">'+esc(l)+"</span>";
    if(/^@@/.test(l))return '<span class="dh">'+esc(l)+"</span>";
    return esc(l);
  }).join("\n");
}
function hl(code,lang){
  var key=ALIAS[(lang||"").toLowerCase()];
  if(!key||code.length>60000)return esc(code);
  if(key==="diff")return hlDiff(code);
  var L=LANGS[key];
  if(!L){
    var rules=RULES[key]();
    L={re:new RegExp(rules.map(function(r){return "("+r[1].source+")"}).join("|"),key==="sql"?"gmi":"gm"),cls:rules.map(function(r){return r[0]})};
    LANGS[key]=L;
  }
  var re=L.re,out="",last=0,m;
  re.lastIndex=0;
  while((m=re.exec(code))){
    if(m[0]===""){re.lastIndex++;continue}
    out+=esc(code.slice(last,m.index));
    var gi=1;
    while(gi<m.length&&m[gi]===undefined)gi++;
    out+='<span class="'+L.cls[gi-1]+'">'+esc(m[0])+"</span>";
    last=m.index+m[0].length;
  }
  return out+esc(code.slice(last));
}
function viewParts(m){
  var r=m.reasoning||"";
  var b=(m.content||"").replace(/<think>([\s\S]*?)(?:<\/think>|$)/g,function(x,t){r+=(r?"\n\n":"")+t;return ""});
  return {body:b,reasoning:r};
}
`;

/* ============================== GALLIUM APP: JS PART 2 (chats, thread, socket, composer, picker) ============================== */

const GAL_JS2 = String.raw`
/* ---------- icons ---------- */
var IC={pin:'<path d="M12 16v5M8 3h8l-1 7 3 4H6l3-4z"/>',edit:'<path d="M4 20h4L19 9l-4-4L4 16z"/>',trash:'<path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/>',
 stop:'<rect x="6.5" y="6.5" width="11" height="11" rx="2" fill="currentColor"/>',send:'<path d="M12 19V5M6 11l6-6 6 6"/>'};
function ic(n){return '<svg viewBox="0 0 24 24">'+IC[n]+"</svg>"}

/* ---------- chats ---------- */
var th=$("#th"),sc=$("#sc"),ta=$("#ta"),stick=true,gen=null,pending=[];
function curChat(){for(var i=0;i<state.chats.length;i++)if(state.chats[i].id===state.cur)return state.chats[i];return null}
function byId(id){for(var i=0;i<state.chats.length;i++)if(state.chats[i].id===id)return state.chats[i];return null}
function findMsg(c,id){if(!c)return null;for(var i=0;i<c.messages.length;i++)if(c.messages[i].id===id)return c.messages[i];return null}
function titleFrom(t){t=String(t||"").replace(/\s+/g," ").trim();return t?(t.length>46?t.slice(0,46)+"...":t):"New chat"}
function newChat(focus){
  var c=curChat();
  if(c&&!c.messages.length){if(focus!==false)ta.focus();return c}
  c={id:uid(),title:"New chat",created:Date.now(),updated:Date.now(),pinned:false,model:state.settings.model,messages:[]};
  state.chats.unshift(c);state.cur=c.id;
  renderAll();saveSoon();
  if(focus!==false)ta.focus();
  return c;
}
function openChat(id){
  if(state.cur===id)return;
  state.cur=id;renderAll();saveSoon();
  if(window.innerWidth<=800&&state.ui.sb){state.ui.sb=false;applySidebar()}
}
function deleteChat(id){
  if(!confirm("Delete this chat?"))return;
  if(gen&&gen.chat.id===id)stopGen();
  state.chats=state.chats.filter(function(c){return c.id!==id});
  if(state.cur===id)state.cur=state.chats.length?state.chats[0].id:null;
  if(!state.cur){newChat(false)}else renderAll();
  saveSoon();
}
function renameChat(id,row){
  var c=byId(id);if(!c)return;
  var rt=$(".rt",row),inp=document.createElement("input"),done=false;
  inp.value=c.title;rt.innerHTML="";rt.appendChild(inp);inp.focus();inp.select();
  function commit(ok){
    if(done)return;done=true;
    if(ok){var v=inp.value.trim();if(v){c.title=v.slice(0,120);saveSoon()}}
    renderList();updateTitle();
  }
  inp.addEventListener("keydown",function(e){e.stopPropagation();if(e.key==="Enter")commit(true);else if(e.key==="Escape")commit(false)});
  inp.addEventListener("blur",function(){commit(true)});
  inp.addEventListener("click",function(e){e.stopPropagation()});
}
function renderList(){
  var q=($("#chatSearch").value||"").trim().toLowerCase(),list=$("#list");
  var arr=state.chats.slice().sort(function(a,b){return (b.pinned?1:0)-(a.pinned?1:0)||b.updated-a.updated});
  if(q)arr=arr.filter(function(c){
    if(c.title.toLowerCase().indexOf(q)>=0)return true;
    return c.messages.some(function(m){return m.content&&m.content.toLowerCase().indexOf(q)>=0});
  });
  list.innerHTML="";
  if(!arr.length){list.innerHTML='<div class="nochats">'+(q?"no matches":"no chats yet")+"</div>";return}
  arr.forEach(function(c){
    var r=document.createElement("div");
    r.className="row"+(c.id===state.cur?" on":"")+(c.pinned?" pin":"");
    r.setAttribute("data-id",c.id);
    r.innerHTML='<div class="rt">'+esc(c.title)+'</div><div class="rm">'+rel(c.updated)+'</div><div class="ra"><button data-r="pin" title="'+(c.pinned?"unpin":"pin")+'">'+ic("pin")+'</button><button data-r="ren" title="rename">'+ic("edit")+'</button><button data-r="del" title="delete">'+ic("trash")+"</button></div>";
    list.appendChild(r);
  });
}
$("#list").addEventListener("click",function(e){
  var r=e.target.closest(".row");if(!r)return;
  var id=r.getAttribute("data-id"),b=e.target.closest("[data-r]");
  if(b){
    e.stopPropagation();
    var k=b.getAttribute("data-r"),c=byId(id);
    if(k==="pin"&&c){c.pinned=!c.pinned;saveSoon();renderList()}
    else if(k==="ren")renameChat(id,r);
    else if(k==="del")deleteChat(id);
    return;
  }
  if(e.target.closest("input"))return;
  openChat(id);
});
$("#chatSearch").addEventListener("input",renderList);
function updateTitle(){var c=curChat();$("#ttl").textContent=c?c.title:""}
function updatePk(){
  var c=curChat(),id=(c&&c.model)||state.settings.model,m=null,i;
  for(i=0;i<models.length;i++)if(models[i].id===id){m=models[i];break}
  if(!m)m={id:id,name:modelName(id)};
  $("#pkIcon").innerHTML=iconHtml(m);
  $("#pkName").textContent=m.name;
}
function renderAll(){renderList();renderThread();updatePk();updateTitle();updateSend()}

/* ---------- messages ---------- */
function emptyEl(){
  var d=document.createElement("div");d.className="empty";
  d.innerHTML=$("#logoS svg").outerHTML+'<span class="wm">gallium</span><p>ask for code, a refactor, a review or a plan. drop files or paste images to attach them.</p>';
  return d;
}
function msgEl(m){
  var el=document.createElement("div");
  el.className="msg "+m.role;el.setAttribute("data-id",m.id);
  var h="";
  if(m.role==="assistant")h+='<div class="mm"></div><div class="tslot"></div>';
  h+='<div class="bubble">';
  if(m.images&&m.images.length)h+='<div class="imgs">'+m.images.map(function(u){return '<img src="'+esc(u)+'" alt="">'}).join("")+"</div>";
  else if(m.imgCount)h+='<div class="note">['+m.imgCount+" image"+(m.imgCount>1?"s":"")+" not saved]</div>";
  h+='<div class="md"></div><div class="err"></div></div>';
  h+='<div class="acts"><button data-a="copy">copy</button>'+(m.role==="assistant"?'<button data-a="regen">regenerate</button><button data-a="continue">continue</button>':"")+'<button data-a="edit">edit</button><button data-a="del">delete</button></div>';
  el.innerHTML=h;
  return el;
}
function renderMsg(m){
  var el=$('[data-id="'+m.id+'"]',th);
  if(!el)return;
  var vp=viewParts(m);
  var md=$(".md",el);
  if(!md)return;
  patch(md,mdBlocks(vp.body));
  if(m.role==="assistant"){
    var mm=$(".mm",el);if(mm)mm.textContent=modelName(m.model||state.settings.model);
    var slot=$(".tslot",el),d=slot.firstChild;
    if(vp.reasoning){
      if(!d){
        d=document.createElement("details");d.className="think";
        d.innerHTML='<summary>thinking</summary><div class="tb md"></div>';
        if(state.settings.thinkopen)d.open=true;
        slot.appendChild(d);
      }
      d.classList.toggle("live",!!m.streaming&&!vp.body.trim());
      patch($(".tb",d),mdBlocks(vp.reasoning));
    }else if(d){slot.removeChild(d)}
  }
  el.classList.toggle("streaming",!!m.streaming);
  el.classList.toggle("waiting",!!m.streaming&&!vp.body&&!vp.reasoning);
  el.classList.toggle("cut",!!m.cut&&!m.streaming);
  var er=$(".err",el);
  if(m.error&&!m.streaming){er.textContent=m.error;er.classList.add("on")}else er.classList.remove("on");
}
function renderThread(){
  th.innerHTML="";
  var c=curChat();
  if(!c||!c.messages.length){th.appendChild(emptyEl());return}
  c.messages.forEach(function(m){th.appendChild(msgEl(m));renderMsg(m)});
  stick=true;scrollEnd();
}

/* ---------- scrolling ---------- */
var lastTop=0;
function nearBottom(){return sc.scrollHeight-sc.scrollTop-sc.clientHeight<90}
function scrollEnd(){sc.scrollTop=sc.scrollHeight}
sc.addEventListener("scroll",function(){
  var nb=nearBottom();
  if(nb)stick=true;else if(sc.scrollTop<lastTop-2)stick=false;
  lastTop=sc.scrollTop;
  $("#jb").classList.toggle("on",!nb);
});
sc.addEventListener("wheel",function(e){if(e.deltaY<0)stick=false},{passive:true});
sc.addEventListener("touchmove",function(){if(!nearBottom())stick=false},{passive:true});
$("#jb").addEventListener("click",function(){stick=true;scrollEnd()});

/* ---------- the one websocket ---------- */
var net={ws:null,open:false,q:[],tries:0,timer:0,ping:0};
function wsUrl(){
  var L;
  try{L=window.parent.location;void L.host}catch(e){L=window.location}
  return (L.protocol==="https:"?"wss:":"ws:")+"//"+(L.host||"")+"/ws";
}
function rawSend(o){try{net.ws.send(typeof o==="string"?o:JSON.stringify(o));return true}catch(e){return false}}
function send(o){
  if(net.open&&net.ws&&net.ws.readyState===1&&rawSend(o))return;
  if(o.type==="ping")return;
  net.q.push(JSON.stringify(o));
  if(net.q.length>60)net.q.shift();
  connect();
}
function sched(){
  clearTimeout(net.timer);
  var d=Math.min(15000,400*Math.pow(2,Math.min(net.tries++,6)))+Math.random()*300;
  net.timer=setTimeout(connect,d);
}
function connect(){
  if(net.ws&&(net.ws.readyState===0||net.ws.readyState===1))return;
  var ws;
  try{ws=new WebSocket(wsUrl())}catch(e){sched();return}
  net.ws=ws;
  ws.onopen=function(){
    net.open=true;net.tries=0;
    var q=net.q;net.q=[];
    q.forEach(function(s){rawSend(s)});
    rawSend({type:"models"});
    clearInterval(net.ping);
    net.ping=setInterval(function(){if(net.open)rawSend({type:"ping"})},25000);
  };
  ws.onmessage=onNet;
  ws.onclose=function(){
    if(net.ws!==ws)return;
    net.open=false;clearInterval(net.ping);
    if(gen)endGen("error","connection lost");
    sched();
  };
  ws.onerror=function(){};
}
function setModels(list){
  var out=[];
  list.forEach(function(x){if(x&&x.id&&typeof x.id==="string")out.push({id:x.id,name:String(x.name||x.id.slice(2)),vision:!!x.vision})});
  if(!out.length)return;
  models=out;metaCache={};
  updatePk();
  if(pick.on)renderPick(false);
}
function onNet(ev){
  var m;
  try{m=JSON.parse(ev.data)}catch(e){return}
  if(!m)return;
  if(m.type==="models"){if(Array.isArray(m.list))setModels(m.list)}
  else if(m.type==="delta"){onDelta(m)}
  else if(m.type==="done"){if(gen&&gen.id===m.id)endGen(m.finish||"stop")}
  else if(m.type==="error"){if(gen&&gen.id===m.id)endGen("error",m.message||"request failed")}
}
document.addEventListener("visibilitychange",function(){if(!document.hidden&&!net.open)connect()});
window.addEventListener("online",connect);

/* ---------- generation ---------- */
var raf=0,dirty=null;
function scheduleRender(m){
  dirty=m;
  if(raf)return;
  raf=requestAnimationFrame(function(){
    raf=0;var d=dirty;dirty=null;
    if(d){renderMsg(d);if(stick)scrollEnd()}
  });
}
function onDelta(m){
  if(!gen||gen.id!==m.id)return;
  var g=gen.msg;
  if(m.content)g.content+=m.content;
  if(m.reasoning)g.reasoning=(g.reasoning||"")+m.reasoning;
  scheduleRender(g);
}
function startStream(chat,msg,isCont,auto){
  var s=state.settings,id=uid(),hist=[],idx=chat.messages.indexOf(msg),i,m;
  var sys=(s.sys||"").trim();
  if(sys)hist.push({role:"system",content:sys});
  for(i=0;i<idx;i++){
    m=chat.messages[i];
    if(!m.content&&!(m.images&&m.images.length))continue;
    hist.push({role:m.role,content:m.content,images:m.images&&m.images.length?m.images:undefined});
  }
  if(isCont){
    hist.push({role:"assistant",content:msg.content});
    hist.push({role:"user",content:CONT_PROMPT});
  }
  var model=chat.model||s.model;
  msg.model=model;msg.streaming=true;msg.cut=false;msg.error=null;msg.finish=null;
  if(!isCont){msg.content="";msg.reasoning=""}
  gen={id:id,chat:chat,msg:msg,auto:auto||0};
  send({type:"chat",id:id,model:model,temperature:s.temp,top_p:s.topp,max_tokens:s.maxtok,effort:s.effort,messages:hist});
  updateSend();renderMsg(msg);
}
function endGen(finish,err){
  var g=gen;
  if(!g)return;
  gen=null;
  var m=g.msg;
  m.streaming=false;m.finish=finish;
  m.cut=(finish==="length"||finish==="error"||finish==="aborted");
  if(err)m.error=err;
  g.chat.updated=Date.now();
  if(finish==="length"&&state.settings.autocont&&g.auto<5){
    startStream(g.chat,m,true,g.auto+1);
    saveSoon();
    return;
  }
  renderMsg(m);updateSend();renderList();saveSoon();
  if(stick&&curChat()===g.chat)scrollEnd();
}
function stopGen(){
  if(!gen)return;
  send({type:"stop",id:gen.id});
  endGen("aborted");
}
function generate(chat){
  var am={id:uid(),role:"assistant",content:"",reasoning:"",model:chat.model||state.settings.model,ts:Date.now(),images:[]};
  chat.messages.push(am);
  th.appendChild(msgEl(am));
  startStream(chat,am,false,0);
}

/* ---------- message actions ---------- */
function flash(btn,txt){
  var o=btn.textContent;btn.textContent=txt;
  setTimeout(function(){btn.textContent=o},1200);
}
function editMsg(m,el){
  var b=$(".bubble",el);
  b.innerHTML='<textarea class="ed"></textarea><div class="edb"><button class="btn sm pri" data-a="save">save</button><button class="btn sm" data-a="cancel">cancel</button></div>';
  var e=$(".ed",b);e.value=m.content;e.focus();
}
th.addEventListener("click",function(ev){
  var cb=ev.target.closest("[data-act]");
  if(cb){
    var code=cb.closest(".code");
    if(cb.getAttribute("data-act")==="copy"){copyText($("code",code).textContent);flash(cb,"copied")}
    else code.classList.toggle("flip");
    return;
  }
  var b=ev.target.closest("[data-a]");
  if(!b)return;
  var el=b.closest(".msg"),chat=curChat(),m=findMsg(chat,el.getAttribute("data-id"));
  if(!m)return;
  var idx=chat.messages.indexOf(m),a=b.getAttribute("data-a");
  if(a==="copy"){copyText(m.content);flash(b,"copied")}
  else if(a==="del"){
    if(gen&&gen.msg===m)stopGen();
    chat.messages.splice(idx,1);el.remove();
    if(!chat.messages.length)renderThread();
    saveSoon();
  }
  else if(a==="regen"){
    if(gen){toast("stop the current answer first");return}
    if(idx<1){toast("nothing to regenerate from");return}
    chat.messages.splice(idx);renderThread();generate(chat);stick=true;scrollEnd();saveSoon();
  }
  else if(a==="continue"){
    if(gen){toast("already generating");return}
    stick=true;startStream(chat,m,true,0);
  }
  else if(a==="edit"){
    if(gen&&gen.msg===m){toast("stop first");return}
    editMsg(m,el);
  }
  else if(a==="cancel"){renderThread()}
  else if(a==="save"){
    var val=$(".ed",el).value.trim();
    if(!val){toast("message is empty");return}
    if(gen)stopGen();
    m.content=val;m.imgCount=m.images&&m.images.length?m.images.length:m.imgCount;
    chat.updated=Date.now();
    if(m.role==="user"){
      chat.messages.splice(idx+1);renderThread();generate(chat);stick=true;scrollEnd();
    }else renderThread();
    renderList();saveSoon();
  }
});

/* ---------- composer ---------- */
function grow(){
  ta.style.height="40px";
  var h=Math.min(ta.scrollHeight,220);
  ta.style.height=Math.max(40,h)+"px";
  ta.style.overflowY=ta.scrollHeight>220?"auto":"hidden";
}
function updateSend(){
  var b=$("#send");
  if(gen){b.innerHTML=ic("stop");b.title="stop";b.classList.remove("idle")}
  else{b.innerHTML=ic("send");b.title="send";b.classList.toggle("idle",!ta.value.trim()&&!pending.length)}
}
function isImg(p){return p.kind==="img"}
function renderTray(){
  var t=$("#tray");
  t.innerHTML=pending.map(function(p,i){
    return '<div class="at">'+(isImg(p)?'<img src="'+esc(p.url)+'" alt="">':"<span>"+esc(p.name)+"</span>")+'<button data-i="'+i+'" title="remove">&times;</button></div>';
  }).join("");
}
$("#tray").addEventListener("click",function(e){
  var b=e.target.closest("button[data-i]");
  if(b){pending.splice(+b.getAttribute("data-i"),1);renderTray();updateSend()}
});
function readImage(f){
  var fr=new FileReader();
  fr.onload=function(){
    var url=fr.result,im=new Image();
    im.onload=function(){
      if(pending.filter(isImg).length>=5){toast("max 5 images");return}
      var mx=Math.max(im.width,im.height);
      if(mx>1600||url.length>1500000){
        var k=Math.min(1,1600/mx),c=document.createElement("canvas");
        c.width=Math.max(1,Math.round(im.width*k));c.height=Math.max(1,Math.round(im.height*k));
        var g=c.getContext("2d");g.fillStyle="#fff";g.fillRect(0,0,c.width,c.height);g.drawImage(im,0,0,c.width,c.height);
        url=c.toDataURL("image/jpeg",.85);
      }else if(!/^data:image\/(png|jpe?g|gif|webp);/.test(url)){toast("unsupported image type");return}
      pending.push({kind:"img",url:url,name:f.name||"image"});
      renderTray();updateSend();
    };
    im.onerror=function(){toast("could not read image")};
    im.src=url;
  };
  fr.readAsDataURL(f);
}
function readText(f){
  var fr=new FileReader();
  fr.onload=function(){
    var ext=(/\.([A-Za-z0-9+#]+)$/.exec(f.name)||[])[1]||"";
    pending.push({kind:"txt",name:f.name,text:String(fr.result),lang:ext.toLowerCase()});
    renderTray();updateSend();
  };
  fr.readAsText(f);
}
function addFiles(files){
  Array.prototype.forEach.call(files,function(f){
    if(/^image\//.test(f.type)){
      if(pending.filter(isImg).length>=5){toast("max 5 images");return}
      readImage(f);
    }else if(/^text\//.test(f.type)||f.type==="application/json"||/\.(txt|md|json|js|jsx|ts|tsx|py|html|css|csv|xml|yml|yaml|sh|c|cpp|h|java|go|rs|php|rb|sql|toml|ini|log|kt|cs|swift|vue|svelte|env|conf|mjs|cjs)$/i.test(f.name)){
      if(f.size>400000){toast("file too large: "+f.name);return}
      readText(f);
    }else toast("unsupported file: "+f.name);
  });
}
$("#attach").addEventListener("click",function(){$("#file").click()});
$("#file").addEventListener("change",function(){addFiles(this.files);this.value=""});
ta.addEventListener("paste",function(e){
  var fl=e.clipboardData&&e.clipboardData.files;
  if(fl&&fl.length){
    var imgs=[];
    Array.prototype.forEach.call(fl,function(f){if(/^image\//.test(f.type))imgs.push(f)});
    if(imgs.length){e.preventDefault();addFiles(imgs)}
  }
});
var dragN=0,mainEl=$("#main");
mainEl.addEventListener("dragenter",function(e){e.preventDefault();dragN++;mainEl.classList.add("dragging")});
mainEl.addEventListener("dragover",function(e){e.preventDefault()});
mainEl.addEventListener("dragleave",function(){dragN=Math.max(0,dragN-1);if(!dragN)mainEl.classList.remove("dragging")});
mainEl.addEventListener("drop",function(e){
  e.preventDefault();dragN=0;mainEl.classList.remove("dragging");
  if(e.dataTransfer&&e.dataTransfer.files&&e.dataTransfer.files.length)addFiles(e.dataTransfer.files);
});
function submit(){
  if(gen){stopGen();return}
  var text=ta.value.trim();
  if(!text&&!pending.length)return;
  var chat=curChat()||newChat(false);
  var imgs=pending.filter(isImg).map(function(p){return p.url});
  var files=pending.filter(function(p){return !isImg(p)});
  var content=text;
  files.forEach(function(f){
    var fence=f.text.indexOf(F3)>=0?F4:F3;
    content+=(content?"\n\n":"")+f.name+"\n"+fence+f.lang+"\n"+f.text+"\n"+fence;
  });
  var um={id:uid(),role:"user",content:content,images:imgs,ts:Date.now()};
  chat.messages.push(um);
  if(chat.messages.length===1||chat.title==="New chat")chat.title=titleFrom(text||(files[0]&&files[0].name)||"images");
  chat.updated=Date.now();
  ta.value="";grow();pending=[];renderTray();
  if(!th.querySelector(".msg"))th.innerHTML="";
  th.appendChild(msgEl(um));renderMsg(um);
  generate(chat);
  stick=true;scrollEnd();renderList();updateTitle();saveSoon();
}
ta.addEventListener("input",function(){grow();updateSend()});
ta.addEventListener("keydown",function(e){
  if(e.key!=="Enter"||e.isComposing)return;
  var es=state.settings.entersend;
  if(es?!e.shiftKey:(e.ctrlKey||e.metaKey)){e.preventDefault();submit()}
});
$("#send").addEventListener("click",submit);

/* ---------- model picker ---------- */
var pick={on:false,q:"",chip:"all",sel:0,items:[]};
var CHIPS=["all","coding","reasoning","general","fast","agentic","vision"];
function subseq(q,s){var i=0,k;for(k=0;k<s.length&&i<q.length;k++)if(s.charAt(k)===q.charAt(i))i++;return i===q.length}
function renderChipsRow(){
  $("#pc").innerHTML=CHIPS.map(function(c){return '<button class="chip'+(pick.chip===c?" on":"")+'" data-c="'+c+'">'+c+"</button>"}).join("");
}
function renderPick(fresh){
  var q=pick.q.trim().toLowerCase(),list=[],c=curChat(),curId=(c&&c.model)||state.settings.model;
  models.forEach(function(m){
    var me=metaOf(m),sc2=0;
    if(pick.chip!=="all"&&me.cats.indexOf(pick.chip)<0)return;
    if(q){
      var nm=m.name.toLowerCase();
      if(nm===q)sc2=100;else if(nm.indexOf(q)===0)sc2=60;else if(nm.indexOf(q)>=0)sc2=40;
      else if(subseq(q,nm))sc2=15;else if(me.brand&&me.brand.indexOf(q)>=0)sc2=10;else return;
    }
    list.push({m:m,me:me,sc:sc2});
  });
  list.sort(function(a,b){return b.sc-a.sc||a.me.rank-b.me.rank||(a.m.name<b.m.name?-1:1)});
  var groups={},order=[];
  list.forEach(function(it){
    var g=pick.chip==="all"?it.me.primary:it.me.family;
    if(!groups[g]){groups[g]=[];order.push(g)}
    groups[g].push(it);
  });
  if(pick.chip==="all"&&!q)order=CAT_ORDER.filter(function(g){return groups[g]});
  var h="";
  pick.items=[];
  order.forEach(function(g){
    h+='<div class="pg">'+esc(g)+"</div>";
    groups[g].forEach(function(it){
      var idx=pick.items.length;
      pick.items.push(it.m);
      h+='<div class="pi'+(idx===pick.sel?" sel":"")+'" data-i="'+idx+'">'+iconHtml(it.m)+'<span class="pn">'+esc(it.m.name)+'</span><span class="pt">'+esc(it.me.cats.filter(function(x){return x!=="general"}).slice(0,2).join(" / "))+'</span><span class="ck">'+(it.m.id===curId?"&#10003;":"")+"</span></div>";
    });
  });
  if(!pick.items.length)h='<div class="pe">no models match</div>';
  if(fresh){
    var f=0;
    for(var k=0;k<pick.items.length;k++)if(pick.items[k].id===curId){f=k;break}
    pick.sel=f;
    renderPick(false);
    return;
  }
  $("#pl").innerHTML=h;
  var el=$('.pi[data-i="'+pick.sel+'"]',$("#pl"));
  if(el)el.scrollIntoView({block:"nearest"});
}
function markSel(){
  $$(".pi",$("#pl")).forEach(function(e){e.classList.toggle("sel",+e.getAttribute("data-i")===pick.sel)});
  var el=$('.pi[data-i="'+pick.sel+'"]',$("#pl"));
  if(el)el.scrollIntoView({block:"nearest"});
}
function openPick(){
  pick.on=true;pick.q="";pick.chip="all";pick.sel=0;
  $("#pop").classList.add("on");$("#pk").classList.add("on");
  $("#pq").value="";renderChipsRow();renderPick(true);
  $("#pq").focus();
}
function closePick(){pick.on=false;$("#pop").classList.remove("on");$("#pk").classList.remove("on")}
function togglePick(){if(pick.on)closePick();else openPick()}
function choose(m){
  if(!m)return;
  var c=curChat()||newChat(false);
  c.model=m.id;state.settings.model=m.id;
  updatePk();closePick();saveSoon();ta.focus();
}
$("#pk").addEventListener("click",togglePick);
$("#pc").addEventListener("click",function(e){
  var b=e.target.closest("[data-c]");
  if(!b)return;
  pick.chip=b.getAttribute("data-c");pick.sel=0;renderChipsRow();renderPick(false);$("#pq").focus();
});
$("#pl").addEventListener("click",function(e){
  var it=e.target.closest(".pi");
  if(it)choose(pick.items[+it.getAttribute("data-i")]);
});
$("#pl").addEventListener("mouseover",function(e){
  var it=e.target.closest(".pi");
  if(it){var i=+it.getAttribute("data-i");if(i!==pick.sel){pick.sel=i;markSel()}}
});
$("#pq").addEventListener("input",function(){pick.q=this.value;pick.sel=0;renderPick(false)});
$("#pq").addEventListener("keydown",function(e){
  if(e.key==="ArrowDown"){e.preventDefault();if(pick.items.length){pick.sel=(pick.sel+1)%pick.items.length;markSel()}}
  else if(e.key==="ArrowUp"){e.preventDefault();if(pick.items.length){pick.sel=(pick.sel-1+pick.items.length)%pick.items.length;markSel()}}
  else if(e.key==="Enter"){e.preventDefault();choose(pick.items[pick.sel])}
  else if(e.key==="Escape"){e.preventDefault();e.stopPropagation();closePick();ta.focus()}
});
document.addEventListener("mousedown",function(e){
  if(pick.on&&!e.target.closest("#pop")&&!e.target.closest("#pk"))closePick();
});

`;

/* ============================== GALLIUM APP: JS PART 3 (settings, effects, trail, data, shortcuts, init) ============================== */

const GAL_JS3 = String.raw`
/* ---------- sidebar ---------- */
var art=null,rects=[];
function calcRects(){
  rects=[];
  ["#sb","#main"].forEach(function(sel){
    var e=$(sel);if(!e)return;
    var r=e.getBoundingClientRect();
    if(r.width>4&&r.height>4)rects.push(r);
  });
}
function maskFn(x,y){
  var m=1,i;
  for(i=0;i<rects.length;i++){
    var r=rects[i],dx=Math.max(r.left-x,0,x-r.right),dy=Math.max(r.top-y,0,y-r.bottom),d=Math.sqrt(dx*dx+dy*dy);
    m=Math.min(m,.16+.84*smooth(0,40,d));
  }
  return m;
}
function applySidebar(){
  $("#app").classList.toggle("sbc",!state.ui.sb);
  clearTimeout(applySidebar.t);
  applySidebar.t=setTimeout(function(){calcRects();if(art)art.remask()},300);
  saveSoon();
}
$("#sbClose").addEventListener("click",function(){state.ui.sb=false;applySidebar()});
$("#sbOpen").addEventListener("click",function(){state.ui.sb=!state.ui.sb;applySidebar()});
$("#newChat").addEventListener("click",function(){newChat(true)});

/* ---------- settings ---------- */
var SCHEMA=[
 {t:"model",k:"sys",l:"system prompt",ty:"area"},
 {t:"model",k:"temp",l:"temperature",ty:"range",min:0,max:2,step:.05},
 {t:"model",k:"topp",l:"top_p",ty:"range",min:0,max:1,step:.01},
 {t:"model",k:"maxtok",l:"max tokens",ty:"num",min:256,max:131072,step:256,h:"sent with every request; lowered automatically if a model has a smaller limit"},
 {t:"model",k:"effort",l:"reasoning effort",ty:"sel",o:["low","medium","high"],h:"only used by gpt-oss style models"},
 {t:"model",k:"autocont",l:"auto-continue when cut off",ty:"tog",h:"up to 5 times, appended to the same message"},
 {t:"model",k:"thinkopen",l:"open thinking by default",ty:"tog"},
 {t:"model",k:"entersend",l:"enter to send",ty:"tog",h:"off: ctrl+enter sends, enter adds a line"},
 {t:"interface",k:"fs",l:"font size",ty:"range",min:12,max:20,step:1,u:"px"},
 {t:"interface",k:"cfs",l:"code font size",ty:"range",min:11,max:18,step:1,u:"px"},
 {t:"interface",k:"cw",l:"content width",ty:"range",min:560,max:1400,step:20,u:"px"},
 {t:"interface",k:"mfont",l:"message font",ty:"sel",o:["sans","serif","mono"]},
 {t:"interface",k:"wrap",l:"wrap code by default",ty:"tog"},
 {t:"interface",k:"colored",l:"colored highlighting",ty:"tog",h:"off: grayscale weights and brightness"},
 {t:"interface",k:"showmodel",l:"show model name on messages",ty:"tog"},
 {t:"interface",k:"blur",l:"blur strength",ty:"range",min:0,max:40,step:1,u:"px"},
 {t:"interface",k:"glass",l:"glass opacity",ty:"range",min:20,max:95,step:1,u:"%"},
 {t:"interface",k:"r",l:"corner radius",ty:"range",min:4,max:28,step:1,u:"px"},
 {t:"interface",k:"anim",l:"animations",ty:"tog"},
 {t:"interface",k:"sbw",l:"sidebar width",ty:"range",min:220,max:420,step:10,u:"px"},
 {t:"interface",k:"compact",l:"compact mode",ty:"tog"},
 {t:"effects",k:"art",l:"background art",ty:"tog"},
 {t:"effects",k:"artb",l:"art brightness",ty:"range",min:5,max:100,step:1,u:"%"},
 {t:"effects",k:"arts",l:"art animation speed",ty:"range",min:10,max:300,step:5,u:"%"},
 {t:"effects",k:"artcell",l:"art cell size",ty:"range",min:7,max:16,step:1,u:"px"},
 {t:"effects",k:"trail",l:"mouse trail",ty:"tog",h:"disabled on touch screens and with reduced motion"},
 {t:"effects",k:"trailn",l:"trail amount",ty:"range",min:10,max:100,step:5,u:"%"},
 {t:"effects",k:"trails",l:"trail size",ty:"range",min:8,max:28,step:1,u:"px"},
 {t:"effects",k:"traill",l:"trail lifetime",ty:"range",min:300,max:3000,step:100,u:"ms"},
 {t:"effects",k:"trailchars",l:"trail characters",ty:"text"}
];
var TABS=["model","interface","effects","data"],tabCur="model",cellT=0;
function setS(k,v){state.settings[k]=v;applySettings();saveSoon()}
function field(f){
  var s=state.settings,w=document.createElement("div");
  w.className="fl";
  var lab='<div class="fll"><div class="flt">'+esc(f.l)+"</div>"+(f.h?'<div class="flh">'+esc(f.h)+"</div>":"")+"</div>";
  if(f.ty==="area"){
    w.className="fl col";
    w.innerHTML=lab+'<textarea class="inp area" spellcheck="false"></textarea><div><button class="btn sm" type="button">reset to default</button></div>';
    var a=$("textarea",w);
    a.value=s[f.k];
    a.addEventListener("input",function(){setS(f.k,a.value)});
    $("button",w).addEventListener("click",function(){a.value=DEFAULTS[f.k];setS(f.k,a.value)});
  }else if(f.ty==="range"){
    w.innerHTML=lab+'<div class="rg"><input type="range" min="'+f.min+'" max="'+f.max+'" step="'+f.step+'"><span class="val"></span></div>';
    var r=$("input",w),v=$(".val",w);
    r.value=s[f.k];
    v.textContent=r.value+(f.u||"");
    r.addEventListener("input",function(){v.textContent=r.value+(f.u||"");setS(f.k,+r.value)});
  }else if(f.ty==="num"){
    w.innerHTML=lab+'<input type="number" min="'+f.min+'" max="'+f.max+'" step="'+f.step+'">';
    var n=$("input",w);
    n.value=s[f.k];
    n.addEventListener("change",function(){var x=clamp(Math.round(+n.value||f.min),f.min,f.max);n.value=x;setS(f.k,x)});
  }else if(f.ty==="sel"){
    w.innerHTML=lab+"<select>"+f.o.map(function(o){return '<option value="'+o+'">'+o+"</option>"}).join("")+"</select>";
    var se=$("select",w);
    se.value=s[f.k];
    se.addEventListener("change",function(){setS(f.k,se.value)});
  }else if(f.ty==="tog"){
    w.innerHTML=lab+'<label class="tg"><input type="checkbox"><i></i></label>';
    var c=$("input",w);
    c.checked=!!s[f.k];
    c.addEventListener("change",function(){setS(f.k,c.checked)});
  }else{
    w.innerHTML=lab+'<input type="text" spellcheck="false">';
    var t=$("input",w);
    t.value=s[f.k];
    t.addEventListener("input",function(){setS(f.k,t.value)});
  }
  return w;
}
function download(name,text,mime){
  var b=new Blob([text],{type:mime||"text/plain"}),u=URL.createObjectURL(b),a=document.createElement("a");
  a.href=u;a.download=name;document.body.appendChild(a);a.click();a.remove();
  setTimeout(function(){URL.revokeObjectURL(u)},4000);
}
function today(){return new Date().toISOString().slice(0,10)}
function chatMd(c){
  var o=["# "+c.title,""];
  c.messages.forEach(function(m){
    o.push("## "+(m.role==="user"?"user":"gallium"));o.push("");
    o.push(m.content||"");o.push("");
  });
  return o.join("\n");
}
function exportAll(){download("gallium-export-"+today()+".json",JSON.stringify(snapshot(false),null,2),"application/json");toast("exported")}
function exportChat(){
  var c=curChat();
  if(!c||!c.messages.length){toast("nothing to export");return}
  download("gallium-"+c.title.replace(/[^a-z0-9]+/gi,"-").replace(/^-|-$/g,"").toLowerCase().slice(0,40)+".md",chatMd(c),"text/markdown");
}
function resetSettings(){
  if(!confirm("Reset all settings to defaults?"))return;
  var model=state.settings.model;
  state.settings=Object.assign({},DEFAULTS,{model:model});
  applySettings();saveSoon();renderSettings();toast("settings reset");
}
function deleteAll(){
  if(!confirm("Delete ALL chats? This cannot be undone."))return;
  if(gen)stopGen();
  state.chats=[];state.cur=null;
  newChat(false);saveSoon();toast("all chats deleted");
}
function dataTab(body){
  [["export everything","chats and settings as JSON","export all",exportAll],
   ["export current chat","markdown file","export chat",exportChat],
   ["import","a JSON file exported from gallium","import",function(){$("#imp").click()}],
   ["reset settings","back to defaults, chats are kept","reset",resetSettings],
   ["delete all chats","cannot be undone","delete all",deleteAll]].forEach(function(r){
    var w=document.createElement("div");w.className="fl";
    w.innerHTML='<div class="fll"><div class="flt">'+esc(r[0])+'</div><div class="flh">'+esc(r[1])+'</div></div><button class="btn sm" type="button">'+esc(r[2])+"</button>";
    $("button",w).addEventListener("click",r[3]);
    body.appendChild(w);
  });
}
function renderSettings(){
  $("#tabs").innerHTML=TABS.map(function(t){return '<button class="tab'+(t===tabCur?" on":"")+'" data-t="'+t+'">'+t+"</button>"}).join("");
  var body=$("#mbody");
  body.innerHTML="";
  if(tabCur==="data")dataTab(body);
  else SCHEMA.forEach(function(f){if(f.t===tabCur)body.appendChild(field(f))});
}
function openSettings(){closePick();$("#mod").classList.add("on");renderSettings()}
function closeSettings(){$("#mod").classList.remove("on")}
$("#tabs").addEventListener("click",function(e){
  var b=e.target.closest("[data-t]");
  if(b){tabCur=b.getAttribute("data-t");renderSettings();$("#mbody").scrollTop=0}
});
$("#openSet").addEventListener("click",openSettings);
$("#modX").addEventListener("click",closeSettings);
$("#mod").addEventListener("mousedown",function(e){if(e.target===this)closeSettings()});
$("#imp").addEventListener("change",function(){
  var f=this.files[0];
  this.value="";
  if(!f)return;
  var fr=new FileReader();
  fr.onload=function(){
    try{
      var j=JSON.parse(fr.result),arr=Array.isArray(j)?j:(j&&Array.isArray(j.chats)?j.chats:null),n=0;
      if(!arr)throw new Error("bad file");
      arr.forEach(function(c){
        if(!c||!Array.isArray(c.messages))return;
        c=JSON.parse(JSON.stringify(c));
        if(!c.id||byId(c.id))c.id=uid();
        c.title=c.title||"Imported chat";c.created=c.created||Date.now();c.updated=c.updated||c.created;
        c.messages=c.messages.filter(Boolean).map(function(m){m.id=m.id||uid();m.images=[];m.streaming=false;m.content=typeof m.content==="string"?m.content:"";return m});
        state.chats.push(c);n++;
      });
      if(j&&!Array.isArray(j)&&j.settings&&confirm("Also import the settings from this file?")){
        state.settings=Object.assign({},DEFAULTS,j.settings);applySettings();
      }
      renderAll();saveSoon();toast("imported "+n+" chat"+(n===1?"":"s"));
    }catch(e){toast("import failed: not a gallium export")}
  };
  fr.readAsText(f);
});

/* ---------- apply settings ---------- */
function applySettings(){
  var s=state.settings,r=document.documentElement.style,b=document.body.classList;
  r.setProperty("--fs",s.fs+"px");r.setProperty("--cfs",s.cfs+"px");r.setProperty("--cw",s.cw+"px");
  r.setProperty("--blur",s.blur+"px");r.setProperty("--glass",(s.glass/100).toFixed(2));
  r.setProperty("--r",s.r+"px");r.setProperty("--ctl-r",Math.min(24,s.r+6)+"px");r.setProperty("--sbw",s.sbw+"px");
  r.setProperty("--msgfont",s.mfont==="serif"?"var(--serif)":s.mfont==="mono"?"var(--mono)":"var(--sans)");
  b.toggle("compact",!!s.compact);b.toggle("colored",!!s.colored);b.toggle("wrapcode",!!s.wrap);
  b.toggle("noanim",!s.anim);b.toggle("nomm",!s.showmodel);
  if(art){
    art.setEnabled(!!s.art);art.setBrightness(s.artb/100);art.setSpeed(s.arts/100);
    clearTimeout(cellT);cellT=setTimeout(function(){art.setCell(state.settings.artcell)},250);
  }
  trailCfg();
  clearTimeout(applySettings.t);
  applySettings.t=setTimeout(function(){calcRects();if(art)art.remask()},300);
}

/* ---------- mouse trail (random basic ascii characters, white/gray, fading) ---------- */
var tr={cv:$("#trail"),ctx:null,ps:[],on:false,raf:0,lx:-1,ly:-1,dpr:1,
 coarse:window.matchMedia("(pointer:coarse)").matches||("ontouchstart" in window),
 reduce:window.matchMedia("(prefers-reduced-motion: reduce)").matches};
function trSize(){
  tr.dpr=Math.min(window.devicePixelRatio||1,2);
  tr.cv.width=Math.round(window.innerWidth*tr.dpr);tr.cv.height=Math.round(window.innerHeight*tr.dpr);
  tr.ctx=tr.cv.getContext("2d");tr.ctx.setTransform(tr.dpr,0,0,tr.dpr,0,0);
}
function trailCfg(){
  tr.on=!!state.settings.trail&&!tr.coarse&&!tr.reduce;
  if(!tr.on){tr.ps=[];if(tr.ctx)tr.ctx.clearRect(0,0,window.innerWidth,window.innerHeight);tr.lx=-1}
}
function trFrame(now){
  tr.raf=0;
  var c=tr.ctx;
  if(!c)return;
  c.clearRect(0,0,window.innerWidth,window.innerHeight);
  var life=Math.max(200,+state.settings.traill||900),keep=[],i,p,age,k;
  c.textAlign="center";c.textBaseline="middle";
  for(i=0;i<tr.ps.length;i++){
    p=tr.ps[i];age=now-p.b;
    if(age>=life||age<0)continue;
    k=1-age/life;
    c.globalAlpha=p.a*k*k;
    c.font=Math.round(p.sz)+"px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";
    c.fillStyle="rgb("+p.g+","+p.g+","+p.g+")";
    c.fillText(p.c,p.x+p.vx*age,p.y+p.vy*age);
    keep.push(p);
  }
  c.globalAlpha=1;
  tr.ps=keep;
  if(keep.length&&!document.hidden)tr.raf=requestAnimationFrame(trFrame);
}
window.addEventListener("pointermove",function(e){
  if(!tr.on||document.hidden||e.pointerType==="touch")return;
  if(tr.lx<0){tr.lx=e.clientX;tr.ly=e.clientY;return}
  var s=state.settings,dx=e.clientX-tr.lx,dy=e.clientY-tr.ly,d=Math.sqrt(dx*dx+dy*dy),gap=Math.max(5,30-s.trailn*.25);
  if(d<gap)return;
  var chars=s.trailchars||"#-+*=",n=s.trailn>75?2:1,i;
  for(i=0;i<n;i++){
    if(tr.ps.length>240)tr.ps.shift();
    tr.ps.push({x:e.clientX+(Math.random()-.5)*10,y:e.clientY+(Math.random()-.5)*10,c:chars.charAt((Math.random()*chars.length)|0),
      b:performance.now(),vx:(Math.random()-.5)*.02,vy:-.005-Math.random()*.02,a:.35+Math.random()*.65,sz:s.trails*(.75+Math.random()*.5),g:150+((Math.random()*105)|0)});
  }
  tr.lx=e.clientX;tr.ly=e.clientY;
  if(!tr.raf)tr.raf=requestAnimationFrame(trFrame);
});
document.addEventListener("pointerleave",function(){tr.lx=-1});
document.addEventListener("visibilitychange",function(){if(document.hidden){tr.ps=[];tr.lx=-1;if(tr.ctx)tr.ctx.clearRect(0,0,window.innerWidth,window.innerHeight)}});
var trRz;
window.addEventListener("resize",function(){clearTimeout(trRz);trRz=setTimeout(trSize,150)});

/* ---------- shortcuts ---------- */
function inField(t){
  var n=t&&t.tagName;
  return n==="INPUT"||n==="TEXTAREA"||n==="SELECT"||(t&&t.isContentEditable);
}
document.addEventListener("keydown",function(e){
  var k=e.key||"";
  if((e.ctrlKey||e.metaKey)&&k.toLowerCase()==="k"){e.preventDefault();if($("#mod").classList.contains("on"))closeSettings();togglePick();return}
  if(e.altKey&&e.code==="KeyN"){e.preventDefault();newChat(true);return}
  if(k==="Escape"){
    if($("#mod").classList.contains("on")){closeSettings();return}
    if(pick.on){closePick();ta.focus()}
    return;
  }
  if(k==="/"&&!inField(e.target)&&!e.ctrlKey&&!e.metaKey&&!e.altKey){e.preventDefault();ta.focus()}
});
window.addEventListener("pagehide",saveNow);

/* ---------- logo reveal ---------- */
function scramble(el,text){
  if(window.matchMedia("(prefers-reduced-motion: reduce)").matches||!state.settings.anim){el.textContent=text;return}
  var G="#@%&01/\\|<>*+=-",n=text.length,st=performance.now();
  (function step(){
    var t=performance.now()-st,out="",i;
    for(i=0;i<n;i++)out+=t>=300+i*90?text.charAt(i):G.charAt((Math.random()*G.length)|0);
    el.textContent=out;
    if(t<300+n*90+60)setTimeout(step,45);else el.textContent=text;
  })();
}

/* ---------- init ---------- */
loadState();
if(window.innerWidth<=800)state.ui.sb=false;
if(!state.chats.length){newChat(false)}
if(!byId(state.cur))state.cur=state.chats[0].id;
$("#app").classList.toggle("sbc",!state.ui.sb);
applySettings();
trSize();trailCfg();
calcRects();
art=AsciiArt.create($("#art"),{brightness:state.settings.artb/100,speed:state.settings.arts/100,cell:state.settings.artcell,contrast:1.58,enabled:!!state.settings.art,mask:maskFn,before:calcRects});
renderAll();grow();
connect();
scramble($("#wmS"),"gallium");
if(window.innerWidth>800)setTimeout(function(){ta.focus()},60);
})();
`;
