// gallium lite — a websocket web proxy + groq agent, in a single Cloudflare Worker file.
//
// deploy:   npx wrangler deploy worker.js --name gallium-lite --compatibility-date 2024-11-01
// ai key:   npx wrangler secret put GROQ_API_KEY      (paste your groq key when prompted)
//
// Everything (page loads, subresources, AI streaming, search, scraping) travels over ONE websocket at /ws.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const GROQ = 'https://api.groq.com/openai/v1';
const CHUNK = 200000;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/ws') {
      if (req.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
      const pair = new WebSocketPair();
      const server = pair[1];
      server.accept();
      session(server, env);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    const wsUrl = (url.protocol === 'http:' ? 'ws:' : 'wss:') + '//' + url.host + '/ws';
    return new Response(shell(appHtml().replace('__WS__', () => wsUrl)), {
      headers: { 'content-type': 'text/html;charset=utf-8', 'cache-control': 'no-store' },
    });
  },
};

/* ───────────────────────────── websocket session ───────────────────────────── */

const out = (ws, o) => { try { ws.send(JSON.stringify(o)); } catch (e) {} };

function session(ws, env) {
  ws.addEventListener('message', (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch (e) { return; }
    const run = { fetch: proxy, ai, tool, models }[m.t];
    if (run) run(ws, m, env).catch((e) => out(ws, { t: 'error', id: m.id, error: String((e && e.message) || e) }));
  });
}

function sendBig(ws, id, s) {
  for (let i = 0; i < s.length; i += CHUNK) out(ws, { t: 'data', id, d: s.slice(i, i + CHUNK) });
}

function toB64(buf) {
  const u = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s);
}
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/* ───────────────────────────── proxy ───────────────────────────── */

async function proxy(ws, m) {
  const id = m.id;
  const u = new URL(m.url);
  if (!/^https?:$/.test(u.protocol)) throw new Error('unsupported protocol');
  const h = new Headers();
  for (const k in m.headers || {}) {
    if (!/^(host|origin|referer|cookie|content-length|connection|accept-encoding|sec-|cf-|x-forwarded|user-agent)/i.test(k)) h.set(k, m.headers[k]);
  }
  h.set('user-agent', UA);
  h.set('accept-language', 'en-US,en;q=0.9');
  h.set('referer', u.origin + '/');
  if (!h.has('accept')) h.set('accept', '*/*');
  const method = (m.method || 'GET').toUpperCase();
  const init = { method, headers: h, redirect: 'follow' };
  if (m.body && method !== 'GET' && method !== 'HEAD') init.body = fromB64(m.body);
  const r = await fetch(u.href, init);
  const ctype = (r.headers.get('content-type') || '').toLowerCase();
  const final = r.url || u.href;
  let kind = 'bin';
  if (/text\/html|application\/xhtml/.test(ctype)) kind = 'html';
  else if (/^text\/|json|javascript|xml|svg/.test(ctype)) kind = 'text';
  const head = { t: 'head', id, status: r.status, ctype, url: final, kind, enc: kind === 'bin' ? 'b64' : 'text', headers: { 'content-type': r.headers.get('content-type') || '' } };
  let body;
  if (kind === 'html') body = await rewriteHtml(r, final);
  else if (kind === 'text') body = await r.text();
  else body = toB64(await r.arrayBuffer());
  out(ws, head);
  sendBig(ws, id, body);
  out(ws, { t: 'end', id });
}

async function rewriteHtml(res, base) {
  const ab = (v) => { try { return new URL(v.trim(), base).href; } catch (e) { return null; } };
  const skip = (v) => !v || /^\s*(data:|blob:|javascript:|about:|#|mailto:|tel:)/i.test(v);
  const fix = (el, at) => { const v = el.getAttribute(at); if (skip(v)) return; const a = ab(v); if (a) el.setAttribute(at, a); };
  const mv = (el, from, to) => {
    const v = el.getAttribute(from);
    if (skip(v)) return;
    const a = ab(v);
    if (!a) return;
    el.removeAttribute(from);
    el.setAttribute(to, a);
  };
  let html = await new HTMLRewriter()
    .on('a,area', { element(e) { fix(e, 'href'); e.removeAttribute('ping'); } })
    .on('form', { element(e) { fix(e, 'action'); } })
    .on('img,source,video,audio,track,embed,iframe,frame,input', {
      element(e) {
        if (e.tagName === 'input' && e.getAttribute('type') !== 'image') return;
        const ss = e.getAttribute('srcset');
        if (ss != null) {
          if (e.tagName === 'source') return e.remove();
          e.removeAttribute('srcset'); e.removeAttribute('sizes');
          if (!e.getAttribute('src')) { const f = ss.trim().split(/\s+/)[0]; if (f) e.setAttribute('src', f); }
        }
        mv(e, 'src', 'data-px-src');
        mv(e, 'poster', 'data-px-poster');
      },
    })
    .on('link', { element(e) { e.removeAttribute('integrity'); mv(e, 'href', 'data-px-href'); } })
    .on('script', {
      element(e) {
        e.removeAttribute('integrity'); e.removeAttribute('nonce');
        if (e.hasAttribute('nomodule')) return e.remove();
        const t = (e.getAttribute('type') || '').toLowerCase();
        if (t && !/^(module|text\/javascript|application\/javascript|text\/ecmascript)$/.test(t)) return;
        if (t === 'module') e.setAttribute('data-px-type', 'module');
        e.setAttribute('type', 'text/px');
        mv(e, 'src', 'data-px-src');
      },
    })
    .on('meta', { element(e) { const h = (e.getAttribute('http-equiv') || '').toLowerCase(); if (h === 'content-security-policy' || h === 'refresh') e.remove(); } })
    .on('base', { element(e) { e.remove(); } })
    .transform(res)
    .text();
  const tag = '<script>' + SHIM_SRC() + '(' + JSON.stringify(base).replace(/</g, '\\u003c') + ')<\/script>';
  if (/<head[^>]*>/i.test(html)) html = html.replace(/<head[^>]*>/i, (x) => x + tag);
  else if (/<html[^>]*>/i.test(html)) html = html.replace(/<html[^>]*>/i, (x) => x + tag);
  else html = html.replace(/^(\s*<!doctype[^>]*>)?/i, (x) => x + tag);
  return html;
}

/* ───────────────────────────── ai + tools ───────────────────────────── */

async function ai(ws, m, env) {
  if (!env.GROQ_API_KEY) throw new Error('GROQ_API_KEY is not set on this worker. Run: npx wrangler secret put GROQ_API_KEY');
  const r = await fetch(GROQ + '/chat/completions', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + env.GROQ_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ model: m.model, messages: m.messages, tools: m.tools, tool_choice: 'auto', stream: true, temperature: 0.6 }),
  });
  if (!r.ok) throw new Error('Groq ' + r.status + ': ' + (await r.text()).slice(0, 400));
  const rd = r.body.getReader(), dec = new TextDecoder();
  let buf = '', content = '';
  const calls = [];
  for (;;) {
    const { done, value } = await rd.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const d = line.slice(5).trim();
      if (d === '[DONE]') continue;
      let j;
      try { j = JSON.parse(d); } catch (e) { continue; }
      const dl = j.choices && j.choices[0] && j.choices[0].delta;
      if (!dl) continue;
      if (dl.content) { content += dl.content; out(ws, { t: 'delta', id: m.id, c: dl.content }); }
      for (const tc of dl.tool_calls || []) {
        const c = calls[tc.index || 0] || (calls[tc.index || 0] = { id: '', type: 'function', function: { name: '', arguments: '' } });
        if (tc.id) c.id = tc.id;
        if (tc.function) {
          if (tc.function.name) c.function.name += tc.function.name;
          if (tc.function.arguments) c.function.arguments += tc.function.arguments;
        }
      }
    }
  }
  const tool_calls = calls.filter(Boolean).map((c, i) => ({ ...c, id: c.id || 'call_' + Date.now() + i }));
  out(ws, { t: 'done', id: m.id, content, tool_calls });
}

async function models(ws, m, env) {
  const r = await fetch(GROQ + '/models', { headers: { authorization: 'Bearer ' + (env.GROQ_API_KEY || '') } });
  const j = await r.json();
  const ids = (j.data || []).map((x) => x.id).filter((x) => !/whisper|tts|guard|playai|distil|embed/i.test(x)).sort();
  out(ws, { t: 'result', id: m.id, result: ids });
}

async function tool(ws, m) {
  const a = m.args || {};
  let result;
  if (m.name === 'web_search') result = await webSearch(String(a.query || ''));
  else if (m.name === 'scrape_url') result = await scrape(String(a.url || ''));
  else throw new Error('unknown tool');
  out(ws, { t: 'result', id: m.id, result });
}

const strip = (s) => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

async function webSearch(q) {
  const r = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q), { headers: { 'user-agent': UA } });
  const h = await r.text();
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  const res = [];
  let x;
  while ((x = re.exec(h)) && res.length < 8) {
    let link = x[1];
    try { const uu = new URL(link, 'https://duckduckgo.com'); link = uu.searchParams.get('uddg') || uu.href; } catch (e) {}
    res.push(res.length + 1 + '. ' + strip(x[2]) + '\n   ' + link + '\n   ' + strip(x[3]));
  }
  return res.length ? res.join('\n') : 'no results';
}

async function scrape(u) {
  const r = await fetch(u, { headers: { 'user-agent': UA, accept: 'text/html,*/*' }, redirect: 'follow' });
  const ct = r.headers.get('content-type') || '';
  const raw = await r.text();
  if (!/html/.test(ct)) return raw.slice(0, 12000);
  const title = (raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
  const links = [];
  raw.replace(/<a[^>]+href="([^"#][^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (m, href, t) => {
    if (links.length < 25 && strip(t)) { try { links.push(strip(t).slice(0, 60) + ' -> ' + new URL(href, r.url).href); } catch (e) {} }
    return m;
  });
  const body = strip(raw.replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, ' ').replace(/<(br|p|div|li|h\d|tr)[^>]*>/gi, '\n'));
  return 'TITLE: ' + strip(title) + '\nURL: ' + r.url + '\n\nTEXT:\n' + body.slice(0, 11000) + '\n\nLINKS:\n' + links.join('\n');
}

/* ───────────────────────────── page shell (outer html + srcdoc iframe) ───────────────────────────── */

const escAttr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

function shell(app) {
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>gallium lite</title>' +
    '<style>html,body{margin:0;height:100%;background:#0a0a0a;overflow:hidden}iframe{border:0;width:100%;height:100%;display:block}</style></head><body>' +
    '<iframe allow="fullscreen; autoplay; clipboard-read; clipboard-write; keyboard-map" allowfullscreen srcdoc="' + escAttr(app) + '"></iframe></body></html>';
}

/* ───────────────────────────── shim: runs inside every proxied page ───────────────────────────── */

let _shim;
function SHIM_SRC() { return _shim || (_shim = 'var __name=function(f){return f};(' + shim.toString() + ')'); }

function shim(BASE) {
  var w = window, P = null, T = null, f = w, n = 0;
  try {
    while (f && n++ < 8) {
      var fe = f.frameElement;
      if (!T && fe && fe.dataset && fe.dataset.tab) T = fe.dataset.tab;
      if (f.parent === f) break;
      f = f.parent;
      if (f.__px) { P = f.__px; break; }
    }
  } catch (e) {}
  if (!P) return;
  var NF = w.fetch.bind(w), SA = Element.prototype.setAttribute;
  function A(u) { try { return new URL(u, BASE).href; } catch (e) { return u; } }
  function bad(u) { return !u || /^\s*(data:|blob:|javascript:|about:|#|mailto:|tel:)/i.test(u); }

  /* fetch / xhr through the parent's websocket */
  w.fetch = function (i, o) {
    o = o || {};
    return (async function () {
      var req = i && i.url ? i : null;
      var u = A(req ? req.url : String(i));
      if (req) { try { if (new URL(req.url).origin === location.origin) u = A(req.url.slice(location.origin.length)); } catch (e) {} }
      if (bad(u)) return NF(i, o);
      var m = (o.method || (req && req.method) || 'GET').toUpperCase(), h = {};
      new Headers(o.headers || (req && req.headers) || {}).forEach(function (v, k) { h[k] = v; });
      var b;
      if (m !== 'GET' && m !== 'HEAD') {
        var src = o.body != null ? o.body : req ? await req.clone().arrayBuffer() : null;
        if (src != null) {
          var rr = new Response(src);
          if (!h['content-type'] && rr.headers.get('content-type')) h['content-type'] = rr.headers.get('content-type');
          b = new Uint8Array(await rr.arrayBuffer());
        }
      }
      var r = await P.fetch(u, { method: m, headers: h, body: b });
      var res = new Response(r.status === 204 || r.status === 304 ? null : r.buf, { status: r.status, headers: r.headers });
      try { Object.defineProperty(res, 'url', { value: r.url }); } catch (e) {}
      return res;
    })();
  };
  function X() { this.readyState = 0; this.status = 0; this.responseText = ''; this.response = null; this.responseType = ''; this._h = {}; this._l = {}; this.upload = { addEventListener: function () {} }; }
  X.DONE = 4; X.LOADING = 3; X.HEADERS_RECEIVED = 2; X.OPENED = 1; X.UNSENT = 0;
  X.prototype = {
    open: function (m, u) { this._m = m; this._u = A(u); this.readyState = 1; this._fire('readystatechange'); },
    setRequestHeader: function (k, v) { this._h[k] = v; },
    getResponseHeader: function (k) { return this._rh ? this._rh[k.toLowerCase()] || null : null; },
    getAllResponseHeaders: function () { var s = ''; for (var k in this._rh || {}) s += k + ': ' + this._rh[k] + '\r\n'; return s; },
    abort: function () { this._ab = 1; }, overrideMimeType: function () {},
    addEventListener: function (t, fn) { (this._l[t] = this._l[t] || []).push(fn); },
    removeEventListener: function (t, fn) { this._l[t] = (this._l[t] || []).filter(function (x) { return x !== fn; }); },
    _fire: function (t) { var s = this, e = { type: t, target: s }; var h = s['on' + t]; if (h) h.call(s, e); (s._l[t] || []).forEach(function (fn) { fn.call(s, e); }); },
    send: function (b) {
      var s = this;
      w.fetch(s._u, { method: s._m, headers: s._h, body: b == null ? undefined : b }).then(function (r) {
        s._rh = {}; r.headers.forEach(function (v, k) { s._rh[k] = v; });
        s.status = r.status; s.statusText = r.statusText || ''; s.responseURL = r.url || s._u;
        s.readyState = 2; s._fire('readystatechange');
        return s.responseType === 'arraybuffer' ? r.arrayBuffer() : s.responseType === 'blob' ? r.blob() : r.text();
      }).then(function (d) {
        if (s._ab) return;
        s.readyState = 4;
        if (s.responseType === '' || s.responseType === 'text') { s.responseText = d; s.response = d; }
        else if (s.responseType === 'json') { try { s.response = JSON.parse(d); } catch (e) { s.response = null; } }
        else s.response = d;
        s._fire('readystatechange'); s._fire('load'); s._fire('loadend');
      }).catch(function () { s.readyState = 4; s._fire('readystatechange'); s._fire('error'); s._fire('loadend'); });
    },
  };
  w.XMLHttpRequest = X;
  navigator.sendBeacon = function () { return true; };
  w.open = function (u) { if (u) P.open(A(u)); return null; };
  history.pushState = history.replaceState = function () {};

  /* sequential script runner (all scripts are shipped as text/px and run through the proxy) */
  function runScript(el) {
    return new Promise(function (done) {
      if (el.getAttribute('data-px-done')) return done();
      SA.call(el, 'data-px-done', '1');
      var s = document.createElement('script'), ty = el.getAttribute('data-px-type');
      if (ty) s.type = ty;
      if (el.id) s.id = el.id;
      var u = el.getAttribute('data-px-src') || el.getAttribute('src');
      function ev(nm) { if (u) el.dispatchEvent(new Event(nm)); done(); }
      function go(t) { s.textContent = t; var par = el.parentNode || document.head; par.insertBefore(s, el.parentNode ? el : null); ev('load'); }
      if (u) P.text(u).then(go, function () { ev('error'); }); else go(el.textContent);
    });
  }
  var Q = Promise.resolve(), ready = 0;
  function enq(el) { Q = Q.then(function () { return runScript(el); }); }

  /* every other subresource: fetched over the websocket, handed back as a blob url */
  function L(el) {
    var tg = el.tagName;
    [['src', 'data-px-src'], ['href', 'data-px-href'], ['poster', 'data-px-poster']].forEach(function (p) {
      var u = el.getAttribute(p[1]);
      if (!u || tg === 'SCRIPT') return;
      el.removeAttribute(p[1]);
      if (tg === 'IFRAME' || tg === 'FRAME') { P.frame(u).then(function (r) { if (r.html != null) el.srcdoc = r.html; else SA.call(el, 'src', r.blob); }, function () {}); return; }
      if (tg === 'LINK') {
        var rel = (el.getAttribute('rel') || '').toLowerCase();
        if (rel.indexOf('stylesheet') > -1) {
          P.text(u).then(function (t) { return P.css(t, u); }).then(function (c) {
            SA.call(el, 'href', URL.createObjectURL(new Blob([c], { type: 'text/css' })));
          }, function () { el.dispatchEvent(new Event('error')); });
        }
        return;
      }
      P.blob(u).then(function (b) {
        SA.call(el, p[0], b);
        if (tg === 'SOURCE' && el.parentNode && /^(VIDEO|AUDIO)$/.test(el.parentNode.tagName)) el.parentNode.load();
      }, function () { el.dispatchEvent(new Event('error')); });
    });
  }
  function sweep(r) {
    if (r.nodeType !== 1) return;
    [r].concat([].slice.call(r.querySelectorAll('[data-px-src],[data-px-href],[data-px-poster],script[type="text/px"]'))).forEach(function (e) {
      if (e.tagName === 'SCRIPT') { if (ready && e.getAttribute('type') === 'text/px') enq(e); }
      else if (e.hasAttribute && (e.hasAttribute('data-px-src') || e.hasAttribute('data-px-href') || e.hasAttribute('data-px-poster'))) L(e);
    });
  }
  new MutationObserver(function (ms) {
    ms.forEach(function (m) {
      if (m.type === 'attributes') { if (m.target.tagName !== 'SCRIPT') L(m.target); }
      else m.addedNodes.forEach(sweep);
    });
  }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-px-src', 'data-px-href', 'data-px-poster'] });

  /* dynamic src/href assignment (new Image().src = ..., script.src = ..., etc.) */
  var HA = { IMG: ['src'], SCRIPT: ['src'], IFRAME: ['src'], FRAME: ['src'], VIDEO: ['src', 'poster'], AUDIO: ['src'], SOURCE: ['src'], TRACK: ['src'], EMBED: ['src'], LINK: ['href'] };
  Element.prototype.setAttribute = function (k, v) {
    var a = HA[this.tagName];
    k = String(k).toLowerCase();
    if (a && a.indexOf(k) > -1 && !bad(String(v))) {
      SA.call(this, 'data-px-' + k, A(String(v)));
      if (this.tagName === 'SCRIPT') SA.call(this, 'type', 'text/px'); else L(this);
      return;
    }
    return SA.apply(this, arguments);
  };
  [[HTMLImageElement, 'src'], [HTMLScriptElement, 'src'], [HTMLIFrameElement, 'src'], [HTMLMediaElement, 'src'], [HTMLSourceElement, 'src'], [HTMLLinkElement, 'href'], [HTMLVideoElement, 'poster']].forEach(function (p) {
    var d = Object.getOwnPropertyDescriptor(p[0].prototype, p[1]);
    if (!d) return;
    Object.defineProperty(p[0].prototype, p[1], { configurable: true, get: d.get, set: function (v) { this.setAttribute(p[1], v); } });
  });

  /* navigation: links + forms go back to the parent so they stay in the proxy */
  document.addEventListener('click', function (e) {
    if (e.defaultPrevented) return;
    var a = e.target.closest && e.target.closest('a[href],area[href]');
    if (!a) return;
    var h = a.getAttribute('href');
    if (!h || /^javascript:/i.test(h)) { e.preventDefault(); return; }
    e.preventDefault();
    if (h.charAt(0) === '#') { var el = document.getElementById(h.slice(1)); if (el) el.scrollIntoView(); return; }
    var u = A(h);
    if (a.target === '_blank' || e.ctrlKey || e.metaKey || e.button === 1) P.open(u); else P.nav(T, u);
  }, true);
  document.addEventListener('submit', function (e) {
    if (e.defaultPrevented) return;
    e.preventDefault();
    var fm = e.target, m = (fm.getAttribute('method') || 'get').toLowerCase(), act = fm.getAttribute('action');
    act = act ? A(act) : BASE;
    var qs = new URLSearchParams(new FormData(fm));
    if (e.submitter && e.submitter.name) qs.append(e.submitter.name, e.submitter.value);
    if (m === 'post') P.nav(T, act, { method: 'POST', body: qs.toString() });
    else { var uu = new URL(act); uu.search = qs.toString(); P.nav(T, uu.href); }
  }, true);

  /* keybinds + esc-hold are handled by the browser shell */
  ['keydown', 'keyup'].forEach(function (t) { document.addEventListener(t, function (e) { P.key(T, e); }, true); });

  document.addEventListener('DOMContentLoaded', function () {
    ready = 1;
    sweep(document.documentElement);
    [].forEach.call(document.querySelectorAll('style'), function (s) {
      if (/url\(|@import/.test(s.textContent)) P.css(s.textContent, BASE).then(function (c) { s.textContent = c; });
    });
    Q = Q.then(function () {
      document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true }));
      w.dispatchEvent(new Event('load'));
      P.meta(T, { title: document.title });
      setTimeout(function () { P.meta(T, { title: document.title }); }, 1500);
    });
  }, { once: true });
}

/* ───────────────────────────── the app (lives inside the srcdoc iframe) ───────────────────────────── */

function appHtml() {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>gallium lite</title>' +
    '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
    '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Inter:wght@400;500&family=JetBrains+Mono:wght@400&display=swap">' +
    '<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css">' +
    '<script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js"><\/script>' +
    '<style>' + APP_CSS + '</style></head><body class="home">' + APP_BODY +
    '<script>window.__WS="__WS__";var __name=function(f){return f};(' + client.toString() + ')()<\/script></body></html>';
}

const APP_CSS = `
:root{--bg:#0a0a0a;--fg:#ededed;--mut:#777;--ln:rgba(255,255,255,.1);--ln2:rgba(255,255,255,.22);--ease:cubic-bezier(.22,1,.36,1)}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{margin:0;height:100%;background:var(--bg);color:var(--fg);font:14px/1.5 Inter,system-ui,sans-serif;overflow:hidden}
button,input,textarea,select{font:inherit;color:inherit;outline:none}
button{background:none;border:0;padding:0}
::selection{background:#fff;color:#000}
::-webkit-scrollbar{width:8px;height:8px}::-webkit-scrollbar-thumb{background:rgba(255,255,255,.12);border-radius:8px}
body.home,body.home *{cursor:none!important}
#bg,#imgbg,#artbg{position:fixed;inset:0;width:100%;height:100%;pointer-events:none;transition:opacity .6s var(--ease)}
#imgbg{background:center/cover no-repeat;filter:grayscale(1) brightness(.35);opacity:0}
#artbg{margin:0;display:flex;align-items:center;justify-content:center;font:12px/1.15 'JetBrains Mono',monospace;color:#fff;opacity:0;white-space:pre;overflow:hidden}
body:not(.home) #bg,body:not(.home) #imgbg,body:not(.home) #artbg{opacity:0!important}
#app{position:relative;height:100%;display:flex;flex-direction:column}
#top{max-height:120px;transition:max-height .5s var(--ease),opacity .4s;position:relative;z-index:5;background:rgba(10,10,10,.6);backdrop-filter:blur(14px)}
body:not(.home) #top{background:var(--bg);border-bottom:1px solid var(--ln)}
body.fs #top{max-height:0;opacity:0;overflow:hidden;pointer-events:none}
#tabrow{display:flex;align-items:center;gap:4px;padding:8px 10px 6px}
#tabs{display:flex;gap:4px;min-width:0;overflow:hidden}
.sp{flex:1}
.ib{width:30px;height:30px;border-radius:9px;display:grid;place-items:center;color:var(--mut);transition:background .25s,color .25s,transform .25s var(--ease),opacity .25s;flex:none}
.ib:hover{background:rgba(255,255,255,.08);color:#fff}.ib:active{transform:scale(.88)}.ib:disabled{opacity:.25;pointer-events:none}.ib.on{color:#fff;background:rgba(255,255,255,.1)}
.tab{display:flex;align-items:center;gap:6px;height:30px;width:190px;min-width:0;padding:0 6px 0 12px;border-radius:9px;color:var(--mut);position:relative;overflow:hidden;transition:background .3s,color .3s,width .3s var(--ease),opacity .25s,transform .3s var(--ease);flex:0 1 190px;white-space:nowrap}
.tab:hover{background:rgba(255,255,255,.05);color:#ddd}.tab.on{background:rgba(255,255,255,.1);color:#fff}
.tab .tt{flex:1;overflow:hidden;text-overflow:ellipsis;font-size:12.5px}
.tab .x{width:20px;height:20px;border-radius:6px;display:grid;place-items:center;opacity:0;transition:opacity .2s,background .2s}
.tab:hover .x,.tab.on .x{opacity:.7}.tab .x:hover{opacity:1;background:rgba(255,255,255,.12)}
.tab.enter{animation:tabIn .4s var(--ease)}.tab.leave{width:0!important;flex-basis:0;opacity:0;padding:0;transform:scale(.8)}
.tab.loading::after{content:'';position:absolute;left:0;bottom:0;height:2px;width:40%;background:#fff;animation:ld 1s var(--ease) infinite}
@keyframes tabIn{from{opacity:0;transform:translateY(8px) scale(.9);width:40px}}
@keyframes ld{from{transform:translateX(-100%)}to{transform:translateX(260%)}}
#tool{display:flex;align-items:center;gap:4px;padding:0 10px;height:0;opacity:0;overflow:hidden;transition:height .45s var(--ease),opacity .35s,padding .45s var(--ease)}
#app.page #tool{height:44px;opacity:1;padding:2px 10px 8px}
#addr{flex:1;height:32px;border-radius:10px;border:1px solid var(--ln);background:rgba(255,255,255,.04);padding:0 14px;font-size:13px;transition:border-color .3s,background .3s}
#addr:focus{border-color:var(--ln2);background:rgba(255,255,255,.07)}
#views{position:relative;flex:1;min-height:0}
.view{position:absolute;inset:0;opacity:0;pointer-events:none;transform:translateY(10px);transition:opacity .5s var(--ease),transform .6s var(--ease)}
.view.on{opacity:1;pointer-events:auto;transform:none}
.frame{position:absolute;inset:0;width:100%;height:100%;border:0;background:#fff;opacity:0;pointer-events:none;transform:scale(.985);transition:opacity .35s var(--ease),transform .5s var(--ease)}
.frame.on{opacity:1;pointer-events:auto;transform:none}
#home{display:flex;flex-direction:column;align-items:center;justify-content:center;padding:0 20px 6vh;text-align:center}
#title{margin:0;font:400 clamp(60px,10vw,132px)/1 'Instrument Serif',serif;letter-spacing:-.025em;animation:rise 1.2s var(--ease) both}
#tip{margin:18px 0 30px;font:12px 'JetBrains Mono',monospace;color:var(--mut);min-height:18px;transition:opacity .35s,transform .35s var(--ease);animation:rise 1.2s .12s var(--ease) both}
#tip.sw{opacity:0;transform:translateY(5px)}
#bar{position:relative;display:flex;align-items:center;gap:4px;width:min(660px,92vw);height:56px;padding:0 8px 0 24px;border-radius:999px;border:1px solid var(--ln);background:rgba(255,255,255,.04);backdrop-filter:blur(10px);transition:border-color .4s,background .4s,box-shadow .5s var(--ease),transform .5s var(--ease);animation:rise 1.2s .22s var(--ease) both}
#bar:focus-within{border-color:var(--ln2);background:rgba(255,255,255,.07);box-shadow:0 0 0 6px rgba(255,255,255,.035),0 20px 60px rgba(0,0,0,.5);transform:translateY(-2px)}
#q{flex:1;min-width:0;height:100%;background:none;border:0;font-size:16px}
#q::placeholder,#aiin::placeholder{color:#555}
#engwrap{position:relative}
#eng{display:flex;align-items:center;gap:6px;height:40px;padding:0 10px 0 12px;border-radius:999px;color:var(--mut);transition:background .25s,color .25s}
#eng:hover,#eng.on{background:rgba(255,255,255,.08);color:#fff}
#eng img,.em img{width:18px;height:18px;display:block}
#eng svg{transition:transform .35s var(--ease)}#eng.on svg{transform:rotate(180deg)}
#engmenu{position:absolute;right:0;top:calc(100% + 12px);min-width:190px;padding:6px;border-radius:16px;background:rgba(18,18,18,.92);backdrop-filter:blur(18px);border:1px solid var(--ln);opacity:0;transform:translateY(-8px) scale(.96);transform-origin:top right;pointer-events:none;transition:opacity .25s,transform .4s var(--ease);z-index:20;text-align:left}
#engmenu.on{opacity:1;transform:none;pointer-events:auto}
.em{display:flex;align-items:center;gap:12px;width:100%;padding:9px 12px;border-radius:11px;color:#bbb;transition:background .2s,color .2s,transform .3s var(--ease)}
.em:hover{background:rgba(255,255,255,.08);color:#fff;transform:translateX(3px)}.em.on{color:#fff}
.send{width:42px;height:42px;border-radius:50%;display:grid;place-items:center;background:#fff;color:#000;flex:none;transition:transform .35s var(--ease),opacity .3s}
.send:hover{transform:scale(1.08) rotate(-8deg)}.send:active{transform:scale(.9)}
#links{display:flex;gap:38px;margin-top:44px;align-items:center;flex-wrap:wrap;justify-content:center;animation:rise 1.2s .34s var(--ease) both}
.sc{display:block;opacity:.5;transition:opacity .3s,transform .45s var(--ease);position:relative}
.sc img{height:26px;width:26px;object-fit:contain;display:block;filter:grayscale(1) brightness(1.6)}
.sc:hover{opacity:1;transform:translateY(-5px) scale(1.12)}
.sc.add{color:#fff;display:grid;place-items:center;height:26px;width:26px}
@keyframes rise{from{opacity:0;transform:translateY(22px);filter:blur(6px)}}
#cur{position:fixed;left:0;top:0;z-index:99999;pointer-events:none;opacity:0;transition:opacity .3s}
body.home #cur{opacity:1}#cur.out{opacity:0!important}
#cur b{position:fixed;left:-3px;top:-3px;width:6px;height:6px;border-radius:50%;background:#fff;transition:opacity .2s}
#cur i{position:fixed;left:-16px;top:-16px;width:32px;height:32px;display:grid;place-items:center}
#cur s{display:block;width:30px;height:30px;border-radius:50%;border:1px solid rgba(255,255,255,.5);transition:transform .45s var(--ease),width .35s var(--ease),height .35s var(--ease),border-radius .35s var(--ease),background .3s,border-color .3s}
#cur[data-s=link] s{transform:scale(1.5);background:rgba(255,255,255,.14);border-color:#fff}
#cur[data-s=link] b{opacity:0}
#cur[data-s=text] s{width:2px;height:26px;border-radius:2px;background:#fff;border-color:#fff}
#cur[data-s=text] b{opacity:0}
#cur[data-d] s{transform:scale(.7)}#cur[data-s=link][data-d] s{transform:scale(1.2)}
.tr{position:fixed;z-index:9999;pointer-events:none;font:700 15px 'JetBrains Mono',monospace;color:#fff;transform:translate(-50%,-50%);animation:tr 1s var(--ease) forwards}
@keyframes tr{from{opacity:.85}to{opacity:0;transform:translate(calc(-50% + var(--dx)),calc(-50% + var(--dy))) rotate(var(--r)) scale(.5)}}
#toast{position:fixed;right:22px;bottom:22px;z-index:100000;padding:12px 16px 14px;border-radius:14px;background:rgba(20,20,20,.92);backdrop-filter:blur(14px);border:1px solid var(--ln2);font-size:13px;opacity:0;transform:translateY(16px) scale(.97);pointer-events:none;transition:opacity .4s var(--ease),transform .5s var(--ease)}
#toast.on{opacity:1;transform:none}
#prog{height:2px;border-radius:2px;background:rgba(255,255,255,.12);margin-top:9px;overflow:hidden}#prog i{display:block;height:100%;width:0;background:#fff}
#ai{position:fixed;right:0;top:0;bottom:0;width:min(440px,100vw);z-index:30;display:flex;flex-direction:column;background:rgba(12,12,12,.94);backdrop-filter:blur(22px);border-left:1px solid var(--ln);transform:translateX(104%);transition:transform .6s var(--ease)}
#app.ai #ai{transform:none}body.fs #ai{display:none}
.aih{display:flex;align-items:center;gap:6px;padding:10px 12px;border-bottom:1px solid var(--ln)}
.aititle{font:italic 22px 'Instrument Serif',serif;margin-right:6px}
#model{max-width:190px;background:rgba(255,255,255,.05);border:1px solid var(--ln);border-radius:9px;padding:5px 8px;font-size:12px;appearance:none;transition:border-color .3s}
#model:hover{border-color:var(--ln2)}#model option{background:#111}
#aibody{flex:1;min-height:0;position:relative}
#msgs,#wsp{position:absolute;inset:0;overflow:auto;padding:16px;transition:opacity .4s var(--ease),transform .5s var(--ease)}
#wsp{opacity:0;pointer-events:none;transform:translateX(24px);display:flex;flex-direction:column;gap:10px}
#ai.ws #wsp{opacity:1;pointer-events:auto;transform:none}#ai.ws #msgs{opacity:0;pointer-events:none;transform:translateX(-24px)}
.msg{margin-bottom:16px;animation:rise .5s var(--ease) both}
.msg.user .b{margin-left:auto;width:fit-content;max-width:88%;padding:9px 14px;border-radius:16px 16px 4px 16px;background:#fff;color:#000;white-space:pre-wrap}
.msg.bot .b{color:#ddd}.msg.bot .b p{margin:0 0 8px}.msg.bot .b ul,.msg.bot .b ol{margin:4px 0 8px;padding-left:20px}
.msg.bot .b h3,.msg.bot .b h4,.msg.bot .b h5{margin:12px 0 6px;font-weight:500}
.msg.bot .b a{color:#fff;text-decoration:underline;text-underline-offset:3px}
.msg.bot .b code{font:12px 'JetBrains Mono',monospace;background:rgba(255,255,255,.08);padding:1px 5px;border-radius:5px}
.msg.bot .b pre{margin:8px 0;padding:12px;border-radius:12px;background:rgba(255,255,255,.05);border:1px solid var(--ln);overflow:auto}.msg.bot .b pre code{background:none;padding:0}
.msg .katex{color:#fff}.msg .katex-display{overflow-x:auto;overflow-y:hidden;padding:4px 0}
.tl{display:flex;align-items:center;gap:8px;margin:4px 0;font:11.5px 'JetBrains Mono',monospace;color:var(--mut);animation:rise .4s var(--ease) both}
.tl i{width:6px;height:6px;border-radius:50%;background:#fff;animation:pulse 1s infinite}.tl.ok i{animation:none;opacity:.35}.tl.err i{animation:none;background:#f66}
.think{display:inline-flex;gap:4px}.think i{width:5px;height:5px;border-radius:50%;background:#888;animation:pulse 1s infinite}.think i:nth-child(2){animation-delay:.15s}.think i:nth-child(3){animation-delay:.3s}
@keyframes pulse{50%{opacity:.2;transform:scale(.7)}}
#aif{display:flex;gap:8px;align-items:flex-end;padding:12px;border-top:1px solid var(--ln)}
#aiin{flex:1;resize:none;max-height:140px;background:rgba(255,255,255,.05);border:1px solid var(--ln);border-radius:14px;padding:10px 14px;transition:border-color .3s}#aiin:focus{border-color:var(--ln2)}
#files{display:flex;flex-direction:column;gap:2px;max-height:34%;overflow:auto}
.fl{display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:9px;color:#aaa;font:12px 'JetBrains Mono',monospace;transition:background .2s,color .2s,transform .3s var(--ease);text-align:left;width:100%}
.fl:hover{background:rgba(255,255,255,.06);color:#fff;transform:translateX(3px)}.fl.on{background:rgba(255,255,255,.1);color:#fff}.fl span{flex:1;overflow:hidden;text-overflow:ellipsis}
#ed{flex:1;display:flex;flex-direction:column;gap:6px;min-height:0}#edname{font:12px 'JetBrains Mono',monospace;color:var(--mut);display:flex;align-items:center;gap:8px}
#edtext{flex:1;resize:none;background:rgba(255,255,255,.04);border:1px solid var(--ln);border-radius:12px;padding:12px;font:12px/1.6 'JetBrains Mono',monospace;white-space:pre;overflow:auto}
.empty{color:#555;font-size:13px;padding:8px 10px}
#modal{position:fixed;inset:0;z-index:50;display:grid;place-items:center;background:rgba(0,0,0,.55);backdrop-filter:blur(6px);opacity:0;pointer-events:none;transition:opacity .4s var(--ease)}
#modal.on{opacity:1;pointer-events:auto}
.card{width:min(520px,92vw);max-height:88vh;overflow:auto;padding:22px;border-radius:22px;background:#0f0f0f;border:1px solid var(--ln2);transform:translateY(20px) scale(.97);transition:transform .6s var(--ease)}
#modal.on .card{transform:none}
.ch{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;font:italic 28px 'Instrument Serif',serif}
.lb{display:block;margin:16px 0 8px;font:11px 'JetBrains Mono',monospace;color:var(--mut);text-transform:uppercase;letter-spacing:.08em}
.seg{display:flex;flex-wrap:wrap;gap:6px}
.seg button{padding:6px 12px;border-radius:999px;border:1px solid var(--ln);color:var(--mut);font-size:12.5px;transition:all .3s var(--ease)}
.seg button:hover{color:#fff;border-color:var(--ln2)}.seg button.on{background:#fff;color:#000;border-color:#fff}
.row{display:flex;justify-content:space-between;align-items:center;margin-top:14px;color:#bbb}
.tg{width:40px;height:22px;border-radius:99px;background:rgba(255,255,255,.12);position:relative;transition:background .35s}
.tg::after{content:'';position:absolute;left:3px;top:3px;width:16px;height:16px;border-radius:50%;background:#fff;transition:transform .45s var(--ease),background .3s}
.tg.on{background:#fff}.tg.on::after{transform:translateX(18px);background:#000}
input[type=range]{accent-color:#fff;width:160px}
.card input[type=text],.card textarea{width:100%;background:rgba(255,255,255,.05);border:1px solid var(--ln);border-radius:12px;padding:9px 12px;transition:border-color .3s}
.card textarea{height:110px;resize:vertical;font:11px/1.2 'JetBrains Mono',monospace;margin-top:8px;white-space:pre}
.card input:focus,.card textarea:focus{border-color:var(--ln2)}
.card input[type=file]{margin-top:8px;font-size:12px;color:var(--mut)}
`;

const APP_BODY = `
<canvas id="bg"></canvas><div id="imgbg"></div><pre id="artbg"></pre>
<div id="cur"><b></b><i><s></s></i></div>
<div id="app">
  <header id="top">
    <div id="tabrow"><div id="tabs"></div><button class="ib" id="newtab" data-ic="plus" title="New tab (Ctrl+T)"></button><span class="sp"></span><button class="ib" id="btnai" data-ic="ai" title="AI (Alt+A)"></button><button class="ib" id="btnset" data-ic="settings" title="Settings"></button></div>
    <div id="tool"><button class="ib" id="back" data-ic="back" title="Back (Alt+Left)"></button><button class="ib" id="fwd" data-ic="fwd" title="Forward"></button><button class="ib" id="reload" data-ic="reload" title="Reload (Ctrl+R)"></button><input id="addr" spellcheck="false" autocomplete="off" placeholder="search or enter address"><button class="ib" id="full" data-ic="full" title="Fullscreen (F11)"></button></div>
  </header>
  <main id="views">
    <section id="home" class="view on">
      <h1 id="title">gallium lite</h1>
      <p id="tip"></p>
      <form id="bar" autocomplete="off">
        <input id="q" spellcheck="false" placeholder="search or type a url" autofocus>
        <div id="engwrap"><button type="button" id="eng" title="Search engine"><img alt=""><span data-ic="chev"></span></button><div id="engmenu"></div></div>
        <button class="send" data-ic="arrow" title="Go"></button>
      </form>
      <div id="links"></div>
    </section>
  </main>
  <aside id="ai">
    <div class="aih"><span class="aititle">ai</span><select id="model"></select><span class="sp"></span><button class="ib" id="aiws" data-ic="file" title="Workspace"></button><button class="ib" id="aiclr" data-ic="trash" title="Clear chat"></button><button class="ib" id="aix" data-ic="x"></button></div>
    <div id="aibody"><div id="msgs"></div><div id="wsp"><div class="aih" style="padding:0;border:0"><span class="lb" style="margin:0;flex:1">workspace</span><button class="ib" id="newfile" data-ic="plus" title="New file"></button></div><div id="files"></div><div id="ed"><div id="edname"></div><textarea id="edtext" spellcheck="false" placeholder="select a file"></textarea></div></div></div>
    <form id="aif"><textarea id="aiin" rows="1" placeholder="ask anything, or tell it to build files"></textarea><button class="send" data-ic="arrow"></button></form>
  </aside>
</div>
<div id="toast"><span id="toasttxt"></span><div id="prog"><i></i></div></div>
<div id="modal"></div>
`;

function client() {
  const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const IC = {
    arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>', x: '<path d="M6 6l12 12M18 6L6 18"/>', plus: '<path d="M12 5v14M5 12h14"/>',
    back: '<path d="M19 12H5M11 6l-6 6 6 6"/>', fwd: '<path d="M5 12h14M13 6l6 6-6 6"/>', reload: '<path d="M20 12a8 8 0 1 1-2.6-5.9M20 4v5h-5"/>',
    full: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>', chev: '<path d="M6 9l6 6 6-6"/>',
    ai: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.7 2.3L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-.7z"/>',
    settings: '<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>',
    file: '<path d="M7 3h7l4 4v14H7zM14 3v4h4"/>', trash: '<path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/>',
  };
  const ic = (n, s = 18) => '<svg width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' + IC[n] + '</svg>';
  $$('[data-ic]').forEach((e) => (e.innerHTML = ic(e.dataset.ic)));
  const store = { get(k, d) { try { const v = JSON.parse(localStorage.getItem('gl.' + k)); return v == null ? d : v; } catch (e) { return d; } }, set(k, v) { try { localStorage.setItem('gl.' + k, JSON.stringify(v)); } catch (e) {} } };
  const cfg = Object.assign({ bg: 'snow', snow: 140, overlay: true, art: '', img: '', trail: true, engine: 0, model: 'llama-3.3-70b-versatile' }, store.get('cfg', {}));
  const saveCfg = () => store.set('cfg', cfg);

  /* ───────── websocket transport ───────── */
  let sock, queue = [], seq = 0;
  const pend = new Map();
  function connect() {
    sock = new WebSocket(window.__WS);
    sock.onopen = () => queue.splice(0).forEach((s) => sock.send(s));
    sock.onmessage = (ev) => {
      const m = JSON.parse(ev.data), p = pend.get(m.id);
      if (!p) return;
      switch (m.t) {
        case 'head': p.head = m; break;
        case 'data': p.parts.push(m.d); break;
        case 'end': pend.delete(m.id); p.res({ head: p.head, body: p.parts.join('') }); break;
        case 'delta': p.on && p.on(m); break;
        case 'done': case 'result': pend.delete(m.id); p.res(m); break;
        case 'error': pend.delete(m.id); p.rej(new Error(m.error)); break;
      }
    };
    sock.onclose = () => { queue = []; pend.forEach((p) => p.rej(new Error('connection lost'))); pend.clear(); setTimeout(connect, 1000); };
  }
  connect();
  function wsReq(msg, on) {
    return new Promise((res, rej) => {
      const id = ++seq;
      pend.set(id, { res, rej, on, parts: [] });
      const s = JSON.stringify({ ...msg, id });
      sock.readyState === 1 ? sock.send(s) : queue.push(s);
    });
  }
  const b64 = (buf) => { const u = new Uint8Array(buf); let s = ''; for (let i = 0; i < u.length; i += 32768) s += String.fromCharCode.apply(null, u.subarray(i, i + 32768)); return btoa(s); };
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  async function raw(url, init = {}) {
    if (/^data:/.test(url)) { const r = await fetch(url); return { head: { status: 200, ctype: r.headers.get('content-type') || '', url, kind: 'bin', enc: 'b64', headers: {} }, body: b64(await r.arrayBuffer()) }; }
    return wsReq({ t: 'fetch', url, method: init.method || 'GET', headers: init.headers || {}, body: init.body ? b64(init.body) : undefined });
  }
  const bytes = (r) => (r.head.enc === 'text' ? new TextEncoder().encode(r.body) : unb64(r.body));
  const textOf = (r) => (r.head.enc === 'text' ? r.body : new TextDecoder().decode(unb64(r.body)));
  const blobs = new Map();
  const blobUrl = (u) => {
    if (!blobs.has(u)) blobs.set(u, raw(u).then((r) => URL.createObjectURL(new Blob([bytes(r)], { type: r.head.ctype || 'application/octet-stream' }))).catch((e) => { blobs.delete(u); throw e; }));
    return blobs.get(u);
  };
  const textUrl = (u) => raw(u).then(textOf);
  async function areplace(s, re, fn) { const m = [...s.matchAll(re)]; const r = await Promise.all(m.map((x) => fn(...x))); let i = 0; return s.replace(re, () => r[i++]); }
  async function css(t, base, d = 0) {
    const A = (u) => { try { return new URL(u, base).href; } catch (e) { return u; } };
    t = await areplace(t, /@import\s+(?:url\(\s*)?['"]?([^'")\s;]+)['"]?\s*\)?[^;]*;/g, async (m, u) => {
      if (d > 2 || /^data:/.test(u)) return '';
      try { return await css(await textUrl(A(u)), A(u), d + 1); } catch (e) { return ''; }
    });
    return areplace(t, /url\(\s*(['"]?)(?!data:|blob:|#)([^'")]+?)\1\s*\)/g, async (m, q, u) => { try { return 'url("' + (await blobUrl(A(u))) + '")'; } catch (e) { return m; } });
  }
  window.__px = {
    text: textUrl, blob: blobUrl, css,
    frame: async (u) => { const r = await raw(u); return r.head.kind === 'html' ? { html: r.body } : { blob: URL.createObjectURL(new Blob([bytes(r)], { type: r.head.ctype })) }; },
    fetch: async (u, init) => { const r = await raw(u, init); return { status: r.head.status, ctype: r.head.ctype, headers: r.head.headers, url: r.head.url, buf: bytes(r) }; },
    nav: (T, u, o) => { const t = tabs.find((x) => x.id === T); if (t) go(t, u, o); },
    open: (u) => newTab(u),
    key: (T, e) => onKey(e),
    meta: (T, m) => { const t = tabs.find((x) => x.id === T); if (t && m.title) setTitle(t, m.title); },
  };

  /* ───────── engines, tips, shortcuts ───────── */
  const SI = (s) => 'https://cdn.simpleicons.org/' + s + '/ffffff';
  const ENG = [
    { n: 'Google', i: 'google', u: 'https://www.google.com/search?q=' },
    { n: 'DuckDuckGo', i: 'duckduckgo', u: 'https://html.duckduckgo.com/html/?q=' },
    { n: 'Bing', i: 'bing', u: 'https://www.bing.com/search?q=' },
    { n: 'Brave', i: 'brave', u: 'https://search.brave.com/search?q=' },
    { n: 'Yahoo', i: 'yahoo', u: 'https://search.yahoo.com/search?p=' },
  ];
  const TIPS = ['remember the big .uk (iykyk)', 'made by aero', 'tip: hold esc for 3s to leave fullscreen', 'tip: alt+t opens a new tab anywhere', 'also try monoxide! .gg/monoxide', 'built with no tracking. except for the cursor, of course', 'build something with the ai and send it to me!', 'fun fact: we dont use scramjet or uv', 'i sure do hope there', 'try typing a question instead of a url', 'cold start, warm thoughts', 'gallium melts in your hand. this site does not.', 'press # $ % & ! ? and nothing happens. wiggle the mouse though.', 'tabs are free, take as many as you like'];
  const tip = $('#tip');
  const setTip = () => { tip.textContent = TIPS[(Math.random() * TIPS.length) | 0]; };
  setTip();
  tip.style.cursor = 'pointer';
  tip.dataset.hover = 1;
  tip.onclick = () => { tip.classList.add('sw'); setTimeout(() => { setTip(); tip.classList.remove('sw'); }, 350); };

  const engBtn = $('#eng'), engMenu = $('#engmenu');
  function renderEng() {
    $('#eng img').src = SI(ENG[cfg.engine].i);
    engMenu.innerHTML = ENG.map((e, i) => '<button type="button" class="em' + (i === cfg.engine ? ' on' : '') + '" data-i="' + i + '"><img src="' + SI(e.i) + '" alt="">' + e.n + '</button>').join('');
  }
  renderEng();
  engBtn.onclick = (e) => { e.stopPropagation(); engMenu.classList.toggle('on'); engBtn.classList.toggle('on'); };
  engMenu.onclick = (e) => { const b = e.target.closest('.em'); if (!b) return; cfg.engine = +b.dataset.i; saveCfg(); renderEng(); closeMenus(); $('#q').focus(); };
  const closeMenus = () => { engMenu.classList.remove('on'); engBtn.classList.remove('on'); };
  document.addEventListener('click', (e) => { if (!e.target.closest('#engwrap')) closeMenus(); });

  let SC = store.get('sc', [
    { n: 'Instagram', u: 'https://www.instagram.com', i: 'instagram' }, { n: 'YouTube', u: 'https://www.youtube.com', i: 'youtube' },
    { n: 'TikTok', u: 'https://www.tiktok.com', i: 'tiktok' }, { n: 'Snapchat', u: 'https://www.snapchat.com', i: 'snapchat' }, { n: 'GitHub', u: 'https://github.com', i: 'github' },
  ]);
  function renderSC() {
    $('#links').innerHTML = SC.map((s, i) => {
      let host = ''; try { host = new URL(s.u).hostname; } catch (e) {}
      return '<a class="sc" data-i="' + i + '" title="' + esc(s.n) + ' (right-click to remove)"><img alt="' + esc(s.n) + '" src="' + (s.i ? SI(s.i) : 'https://www.google.com/s2/favicons?sz=64&domain=' + host) + '"></a>';
    }).join('') + '<a class="sc add" title="Add shortcut">' + ic('plus', 22) + '</a>';
  }
  renderSC();
  $('#links').onclick = (e) => {
    const a = e.target.closest('.sc'); if (!a) return;
    if (a.classList.contains('add')) {
      const u = prompt('Site address'); const r = u && resolve(u, true); if (!r) return;
      let h = r; try { h = new URL(r).hostname.replace(/^www\./, ''); } catch (er) {}
      SC.push({ n: h, u: r }); store.set('sc', SC); renderSC(); return;
    }
    go(active, SC[+a.dataset.i].u);
  };
  $('#links').oncontextmenu = (e) => { const a = e.target.closest('.sc:not(.add)'); if (!a) return; e.preventDefault(); SC.splice(+a.dataset.i, 1); store.set('sc', SC); renderSC(); };

  /* ───────── tabs ───────── */
  const tabs = [], closed = [];
  let active = null, tid = 0;
  const views = $('#views'), home = $('#home'), tabsEl = $('#tabs'), addr = $('#addr'), appEl = $('#app');
  const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return u; } };
  function resolve(v, urlOnly) {
    v = v.trim(); if (!v) return null;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return v;
    if (!/\s/.test(v) && /^(localhost|[\w-]+(\.[\w-]+)+)(:\d+)?([/?#].*)?$/i.test(v)) return 'https://' + v;
    return urlOnly ? null : ENG[cfg.engine].u + encodeURIComponent(v);
  }
  function setTitle(t, s) { t.title = s || t.title; t.el.querySelector('.tt').textContent = t.title; }
  function newTab(url, bg) {
    const t = { id: 't' + ++tid, title: 'New Tab', url: '', hist: [], i: -1, home: true, frame: null };
    const el = document.createElement('div');
    el.className = 'tab enter'; el.dataset.hover = 1;
    el.innerHTML = '<span class="tt">New Tab</span><button class="x">' + ic('x', 13) + '</button>';
    el.onclick = (e) => { if (e.target.closest('.x')) closeTab(t); else select(t); };
    el.onauxclick = (e) => { if (e.button === 1) closeTab(t); };
    t.el = el; tabsEl.appendChild(el); tabs.push(t);
    if (url) go(t, url);
    if (!bg) select(t);
    return t;
  }
  function select(t) {
    active = t;
    tabs.forEach((x) => { x.el.classList.toggle('on', x === t); if (x.frame) x.frame.classList.toggle('on', x === t && !x.home); });
    home.classList.toggle('on', t.home);
    document.body.classList.toggle('home', t.home);
    appEl.classList.toggle('page', !t.home);
    addr.value = t.url; navState();
    if (t.home) { exitFs(); setTimeout(() => $('#q').focus(), 60); }
  }
  function navState() { $('#back').disabled = !(active && active.i > 0); $('#fwd').disabled = !(active && active.i < active.hist.length - 1); }
  function closeTab(t) {
    const i = tabs.indexOf(t); if (i < 0) return;
    if (t.url) closed.push(t.url);
    tabs.splice(i, 1);
    t.el.classList.add('leave'); setTimeout(() => t.el.remove(), 260);
    if (t.frame) { t.frame.classList.remove('on'); const f = t.frame; setTimeout(() => f.remove(), 400); }
    if (!tabs.length) newTab(); else if (active === t) select(tabs[Math.min(i, tabs.length - 1)]);
  }
  function ensureFrame(t) {
    if (!t.frame) {
      const f = document.createElement('iframe');
      f.className = 'frame'; f.dataset.tab = t.id; f.allow = 'fullscreen; autoplay; clipboard-write'; f.setAttribute('allowfullscreen', '');
      views.appendChild(f); t.frame = f;
    }
    t.home = false;
  }
  const errPage = (u, m) => '<body style="margin:0;background:#0a0a0a;color:#ededed;font:15px system-ui;display:grid;place-items:center;height:100vh"><div style="max-width:440px;padding:24px"><div style="font:italic 40px Georgia,serif">oops! contact @34mss on discord.</div><p style="color:#888;word-break:break-all">' + esc(u) + '</p><p style="color:#bbb">' + esc(m) + '</p></div></body>';
  async function go(t, url, o = {}) {
    const mode = o.mode || 'push';
    if (mode === 'push') { t.hist = t.hist.slice(0, t.i + 1); t.hist.push(url); t.i = t.hist.length - 1; }
    t.url = url; ensureFrame(t);
    const n = (t.nav = (t.nav || 0) + 1);
    t.el.classList.add('loading'); setTitle(t, hostOf(url));
    if (t === active) select(t);
    try {
      const init = o.method && o.method !== 'GET' ? { method: o.method, body: new TextEncoder().encode(o.body || ''), headers: { 'content-type': 'application/x-www-form-urlencoded' } } : {};
      const r = await raw(url, init);
      if (t.nav !== n) return;
      t.url = r.head.url || url; t.hist[t.i] = t.url;
      if (r.head.kind === 'html') { t.frame.removeAttribute('src'); t.frame.srcdoc = r.body; }
      else { t.frame.removeAttribute('srcdoc'); t.frame.src = URL.createObjectURL(new Blob([bytes(r)], { type: r.head.ctype })); }
      setTitle(t, hostOf(t.url));
    } catch (e) { if (t.nav === n) t.frame.srcdoc = errPage(url, e.message); }
    setTimeout(() => t.el.classList.remove('loading'), 700);
    if (t === active) { addr.value = t.url; navState(); }
  }
  $('#newtab').onclick = () => newTab();
  $('#back').onclick = () => { if (active.i > 0) { active.i--; go(active, active.hist[active.i], { mode: 'hist' }); } };
  $('#fwd').onclick = () => { if (active.i < active.hist.length - 1) { active.i++; go(active, active.hist[active.i], { mode: 'hist' }); } };
  $('#reload').onclick = () => active.url && go(active, active.url, { mode: 'hist' });
  $('#full').onclick = () => enterFs();
  addr.onkeydown = (e) => { if (e.key === 'Enter') { const u = resolve(addr.value); if (u) { go(active, u); addr.blur(); } } };
  addr.onfocus = () => addr.select();
  $('#bar').onsubmit = (e) => { e.preventDefault(); const u = resolve($('#q').value); if (u) { $('#q').value = ''; go(active, u); } };

  /* ───────── fullscreen (hold esc 3s to leave) + keybinds ───────── */
  let fs = false, hold = null, tt;
  const toastEl = $('#toast');
  function toast(txt, dur) { $('#toasttxt').textContent = txt; toastEl.classList.add('on'); clearTimeout(tt); if (dur) tt = setTimeout(() => toastEl.classList.remove('on'), dur); }
  function prog(on) { const b = $('#prog i'); b.style.transition = 'none'; b.style.width = '0'; if (on) { b.offsetWidth; b.style.transition = 'width 3s linear'; b.style.width = '100%'; } }
  function enterFs() {
    if (!active || active.home) return;
    fs = true; document.body.classList.add('fs');
    try {
      const T = window.top, p = T.document.documentElement.requestFullscreen();
      p && p.then(() => { try { (T.navigator.keyboard || navigator.keyboard).lock().catch(() => {}); } catch (e) {} }).catch(() => {});
    } catch (e) {}
    prog(false); toast('To leave fullscreen, hold Esc for 3 seconds', 5000);
  }
  function exitFs() {
    if (!fs) return;
    fs = false; document.body.classList.remove('fs'); stopHold(true);
    try { const T = window.top; if (T.document.fullscreenElement) T.document.exitFullscreen(); (T.navigator.keyboard || navigator.keyboard).unlock(); } catch (e) {}
    toastEl.classList.remove('on');
  }
  function startHold() { if (hold) return; clearTimeout(tt); toast('Keep holding Esc to leave fullscreen', 0); prog(true); hold = setTimeout(() => { hold = null; exitFs(); }, 3000); }
  function stopHold(silent) { if (!hold) return; clearTimeout(hold); hold = null; prog(false); if (!silent) toast('To leave fullscreen, hold Esc for 3 seconds', 2500); }
  addEventListener('blur', () => stopHold());
  function closeOverlays() { closeMenus(); $('#modal').classList.remove('on'); }
  function onKey(e) {
    const k = (e.key || '').toLowerCase();
    if (k === 'escape') { if (e.type === 'keyup') stopHold(); else if (fs) { e.preventDefault(); startHold(); } else closeOverlays(); return; }
    if (e.type !== 'keydown') return;
    const c = e.ctrlKey || e.metaKey, m = c || e.altKey, sh = e.shiftKey;
    const cyc = (d) => { const i = tabs.indexOf(active); select(tabs[(i + d + tabs.length) % tabs.length]); };
    let a = null;
    if (m && !sh && k === 't') a = () => newTab();
    else if (m && sh && k === 't') a = () => closed.length && newTab(closed.pop());
    else if (m && k === 'w') a = () => closeTab(active);
    else if ((c && k === 'tab' && !sh) || (m && (k === 'pagedown' || k === ']'))) a = () => cyc(1);
    else if ((c && k === 'tab' && sh) || (m && (k === 'pageup' || k === '['))) a = () => cyc(-1);
    else if (m && k === 'l') a = () => { if (active.home) $('#q').focus(); else addr.focus(); };
    else if ((m && k === 'r') || k === 'f5') a = () => active.url && go(active, active.url, { mode: 'hist' });
    else if (e.altKey && !c && k === 'arrowleft') a = () => $('#back').click();
    else if (e.altKey && !c && k === 'arrowright') a = () => $('#fwd').click();
    else if (m && /^[1-9]$/.test(k)) a = () => select(k === '9' ? tabs[tabs.length - 1] : tabs[+k - 1] || active);
    else if (k === 'f11') a = () => (fs ? null : enterFs());
    else if (e.altKey && !c && k === 'a') a = () => toggleAI();
    if (a) { e.preventDefault(); e.stopPropagation(); a(); }
  }
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('keyup', onKey, true);

  /* ───────── cursor + ascii trail (home only) ───────── */
  const cur = $('#cur'), dot = $('#cur b'), ring = $('#cur i');
  let mx = -100, my = -100, rx = -100, ry = -100, lx = 0, ly = 0;
  const CH = '#$%&!?';
  addEventListener('mousemove', (e) => {
    mx = e.clientX; my = e.clientY; dot.style.transform = 'translate(' + mx + 'px,' + my + 'px)'; cur.classList.remove('out');
    if (!cfg.trail || !document.body.classList.contains('home')) return;
    if (Math.hypot(mx - lx, my - ly) < 26) return;
    lx = mx; ly = my;
    const s = document.createElement('span'); s.className = 'tr'; s.textContent = CH[(Math.random() * CH.length) | 0];
    s.style.cssText = 'left:' + lx + 'px;top:' + ly + 'px;--dx:' + (Math.random() - 0.5) * 34 + 'px;--dy:' + (-10 - Math.random() * 34) + 'px;--r:' + (Math.random() - 0.5) * 70 + 'deg';
    document.body.appendChild(s); setTimeout(() => s.remove(), 1000);
  });
  (function loop() { rx += (mx - rx) * 0.2; ry += (my - ry) * 0.2; ring.style.transform = 'translate(' + rx + 'px,' + ry + 'px)'; requestAnimationFrame(loop); })();
  document.addEventListener('mouseover', (e) => {
    const t = e.target.closest ? e.target : e.target.parentElement;
    cur.dataset.s = t.closest('input,textarea') ? 'text' : t.closest('a,button,select,label,[data-hover],.em,.fl,.tab') ? 'link' : '';
  });
  document.addEventListener('mousedown', () => (cur.dataset.d = 1));
  document.addEventListener('mouseup', () => delete cur.dataset.d);
  document.documentElement.addEventListener('mouseleave', () => cur.classList.add('out'));

  /* ───────── background (snow / matrix / ascii waves / art / image) ───────── */
  const cv = $('#bg'), cx = cv.getContext('2d');
  let W = 0, H = 0, flakes = [], drops = [], last = 0, stepAt = 0;
  function resize() {
    const d = devicePixelRatio || 1; W = innerWidth; H = innerHeight; cv.width = W * d; cv.height = H * d; cx.setTransform(d, 0, 0, d, 0, 0);
    drops = Array.from({ length: Math.ceil(W / 16) }, () => Math.random() * -50);
    mkSnow();
  }
  function mkSnow() { flakes = Array.from({ length: cfg.snow }, () => { const r = 0.8 + Math.random() * 2; return { x: Math.random() * W, y: Math.random() * H, r, vy: 0.25 + r * 0.28, ph: Math.random() * 6.28, a: 0.25 + Math.random() * 0.65 }; }); }
  addEventListener('resize', resize); resize();
  const ART = {
    mountains: String.raw`
              /\
             /  \        /\
      /\    /    \  /\  /  \
     /  \  /      \/  \/    \    /\
    /    \/                  \  /  \
   /                          \/    \
  ----------------------------------------`,
    moon: String.raw`
        _..._
      .::::. \
     :::::::.  \
     ::::::::   :
     '::::::'  /
       '::::' /
          '''`,
    stars: String.raw`
   .        *          .       +
        .        .   *     .
   *        +        .          *
       .         *        .
   +        .         +      .`,
  };
  const RAMP = ' .:-=+*#%@';
  function applyBg() {
    const art = cfg.bg === 'art', img = cfg.bg === 'img';
    $('#artbg').textContent = art ? cfg.art || ART.mountains : '';
    $('#artbg').style.opacity = art ? 0.22 : 0;
    $('#imgbg').style.backgroundImage = img && cfg.img ? 'url("' + cfg.img.replace(/"/g, '%22') + '")' : 'none';
    $('#imgbg').style.opacity = img ? 1 : 0;
    cx.clearRect(0, 0, W, H); mkSnow();
  }
  function snow(t, dt) {
    cx.fillStyle = '#fff';
    for (const f of flakes) {
      f.y += f.vy * dt * 60; f.x += Math.sin(t / 1600 + f.ph) * 0.4 * dt * 60 + 0.12;
      if (f.y > H + 5) { f.y = -5; f.x = Math.random() * W; } if (f.x > W + 5) f.x = -5; if (f.x < -5) f.x = W + 5;
      cx.globalAlpha = f.a; cx.beginPath(); cx.arc(f.x, f.y, f.r, 0, 6.283); cx.fill();
    }
    cx.globalAlpha = 1;
  }
  function frame(t) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.05, (t - last) / 1000); last = t;
    if (!document.body.classList.contains('home')) return;
    if (cfg.bg === 'matrix') {
      if (t - stepAt < 55) return; stepAt = t;
      cx.fillStyle = 'rgba(10,10,10,.14)'; cx.fillRect(0, 0, W, H); cx.font = '14px JetBrains Mono, monospace';
      drops.forEach((y, i) => { cx.fillStyle = y > 0 && Math.random() > 0.97 ? '#fff' : 'rgba(255,255,255,.45)'; cx.fillText(String.fromCharCode(0x30a0 + Math.random() * 60), i * 16, y * 16); drops[i] = y * 16 > H && Math.random() > 0.975 ? 0 : y + 1; });
      return;
    }
    cx.clearRect(0, 0, W, H);
    if (cfg.bg === 'waves') {
      if (t - stepAt < 33) return; stepAt = t; cx.font = '13px JetBrains Mono, monospace';
      for (let y = 0; y < H / 16; y++) for (let x = 0; x < W / 10; x++) {
        const v = Math.sin(x * 0.09 + t * 0.0012) + Math.sin(y * 0.12 - t * 0.0009) + Math.sin((x + y) * 0.05 + t * 0.0007);
        const i = Math.floor(((v + 3) / 6) * RAMP.length);
        if (i > 1) { cx.fillStyle = 'rgba(255,255,255,' + (0.03 + i * 0.022) + ')'; cx.fillText(RAMP[i], x * 10, y * 16); }
      }
      return;
    }
    if (cfg.bg === 'snow' || ((cfg.bg === 'art' || cfg.bg === 'img') && cfg.overlay)) snow(t, dt);
  }
  applyBg(); requestAnimationFrame(frame);

  function openSettings() {
    const m = $('#modal');
    const tg = (id, v) => '<button type="button" class="tg' + (v ? ' on' : '') + '" id="' + id + '"></button>';
    m.innerHTML = '<div class="card"><div class="ch"><span>settings</span><button class="ib" id="mx">' + ic('x') + '</button></div>' +
      '<span class="lb">background</span><div class="seg" id="bgseg">' + [['snow', 'snow'], ['matrix', 'matrix'], ['waves', 'ascii waves'], ['art', 'ascii art'], ['img', 'image'], ['none', 'none']].map((x) => '<button data-k="' + x[0] + '" class="' + (cfg.bg === x[0] ? 'on' : '') + '">' + x[1] + '</button>').join('') + '</div>' +
      '<div class="row"><span>snow density</span><input type="range" id="sn" min="0" max="400" value="' + cfg.snow + '"></div>' +
      '<div class="row"><span>snow over art / image</span>' + tg('ov', cfg.overlay) + '</div>' +
      '<div class="row"><span>ascii mouse trail</span>' + tg('tr', cfg.trail) + '</div>' +
      '<span class="lb">ascii art</span><div class="seg" id="presets">' + Object.keys(ART).map((k) => '<button data-p="' + k + '">' + k + '</button>').join('') + '</div>' +
      '<textarea id="arttx" spellcheck="false" placeholder="paste your own ascii art, then pick the \'ascii art\' background">' + esc(cfg.art) + '</textarea>' +
      '<span class="lb">image</span><input type="text" id="imgu" placeholder="https://… image url" value="' + esc(cfg.img.startsWith('data:') ? '' : cfg.img) + '"><input type="file" id="imgf" accept="image/*"></div>';
    m.classList.add('on');
    const close = () => m.classList.remove('on');
    m.onclick = (e) => { if (e.target === m) close(); };
    $('#mx').onclick = close;
    $('#bgseg').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; cfg.bg = b.dataset.k; saveCfg(); $$('#bgseg button').forEach((x) => x.classList.toggle('on', x === b)); applyBg(); };
    $('#sn').oninput = (e) => { cfg.snow = +e.target.value; saveCfg(); mkSnow(); };
    $('#ov').onclick = (e) => { cfg.overlay = !cfg.overlay; saveCfg(); e.currentTarget.classList.toggle('on', cfg.overlay); applyBg(); };
    $('#tr').onclick = (e) => { cfg.trail = !cfg.trail; saveCfg(); e.currentTarget.classList.toggle('on', cfg.trail); };
    $('#presets').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; cfg.art = ART[b.dataset.p]; cfg.bg = 'art'; $('#arttx').value = cfg.art; saveCfg(); $$('#bgseg button').forEach((x) => x.classList.toggle('on', x.dataset.k === 'art')); applyBg(); };
    $('#arttx').oninput = (e) => { cfg.art = e.target.value; saveCfg(); if (cfg.bg === 'art') applyBg(); };
    $('#imgu').onchange = (e) => { cfg.img = e.target.value.trim(); cfg.bg = 'img'; saveCfg(); $$('#bgseg button').forEach((x) => x.classList.toggle('on', x.dataset.k === 'img')); applyBg(); };
    $('#imgf').onchange = (e) => { const f = e.target.files[0]; if (!f) return; const r = new FileReader(); r.onload = () => { cfg.img = r.result; cfg.bg = 'img'; saveCfg(); $$('#bgseg button').forEach((x) => x.classList.toggle('on', x.dataset.k === 'img')); applyBg(); }; r.readAsDataURL(f); };
  }
  $('#btnset').onclick = openSettings;

  /* ───────── AI: groq over websocket, workspace tools, latex ───────── */
  const aiEl = $('#ai'), msgs = $('#msgs');
  function toggleAI(force) { const on = force == null ? !appEl.classList.contains('ai') : force; appEl.classList.toggle('ai', on); $('#btnai').classList.toggle('on', on); if (on) { setTimeout(() => $('#aiin').focus(), 300); loadModels(); } }
  $('#btnai').onclick = () => toggleAI(); $('#aix').onclick = () => toggleAI(false);
  $('#aiws').onclick = () => { aiEl.classList.toggle('ws'); $('#aiws').classList.toggle('on', aiEl.classList.contains('ws')); };
  const MODELS = ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'llama-3.1-8b-instant', 'meta-llama/llama-4-scout-17b-16e-instruct', 'qwen/qwen3-32b', 'moonshotai/kimi-k2-instruct'];
  const modelSel = $('#model');
  function fillModels(list) { modelSel.innerHTML = list.map((m) => '<option' + (m === cfg.model ? ' selected' : '') + '>' + esc(m) + '</option>').join(''); }
  fillModels(MODELS);
  modelSel.onchange = () => { cfg.model = modelSel.value; saveCfg(); };
  let modelsLoaded = false;
  function loadModels() { if (modelsLoaded) return; modelsLoaded = true; wsReq({ t: 'models' }).then((r) => { if (r.result && r.result.length) { const l = r.result.includes(cfg.model) ? r.result : [cfg.model, ...r.result]; fillModels(l); } }).catch(() => (modelsLoaded = false)); }

  let WS = store.get('ws', {}), sel = null;
  const saveWs = () => { store.set('ws', WS); renderFiles(); };
  function renderFiles() {
    const names = Object.keys(WS);
    $('#files').innerHTML = names.length ? names.map((n) => '<button class="fl' + (n === sel ? ' on' : '') + '" data-n="' + esc(n) + '">' + ic('file', 14) + '<span>' + esc(n) + '</span></button>').join('') : '<div class="empty">no files yet. ask the ai to create some.</div>';
    if (sel && !(sel in WS)) sel = null;
    $('#edname').innerHTML = sel ? '<span style="flex:1">' + esc(sel) + '</span><button class="ib" id="delf" title="Delete" style="width:24px;height:24px">' + ic('trash', 14) + '</button>' : '';
    const ta = $('#edtext'); if (document.activeElement !== ta) ta.value = sel ? WS[sel] : '';
    ta.disabled = !sel;
    if (sel) $('#delf').onclick = () => { delete WS[sel]; sel = null; saveWs(); };
  }
  $('#files').onclick = (e) => { const b = e.target.closest('.fl'); if (b) { sel = b.dataset.n; renderFiles(); } };
  $('#edtext').oninput = (e) => { if (sel) { WS[sel] = e.target.value; store.set('ws', WS); } };
  $('#newfile').onclick = () => { const n = prompt('File name'); if (n) { WS[n] = WS[n] || ''; sel = n; saveWs(); } };
  renderFiles();

  const lines = (s) => s.split('\n');
  const num = (v) => Number(v);
  const TOOLFN = {
    list_files: () => (Object.keys(WS).length ? Object.entries(WS).map(([k, v]) => k + ' (' + lines(v).length + ' lines)').join('\n') : '(workspace is empty)'),
    read_file: (a) => { if (!(a.path in WS)) throw new Error('no such file: ' + a.path); const L = lines(WS[a.path]), s = Math.max(1, num(a.start_line) || 1), e = Math.min(L.length, num(a.end_line) || L.length); return L.slice(s - 1, e).map((l, i) => s + i + '| ' + l).join('\n') || '(empty file)'; },
    create_file: (a) => { const ex = a.path in WS; WS[a.path] = a.content == null ? '' : String(a.content); sel = a.path; return (ex ? 'overwrote ' : 'created ') + a.path + ' (' + lines(WS[a.path]).length + ' lines)'; },
    edit_lines: (a) => {
      if (!(a.path in WS)) throw new Error('no such file: ' + a.path);
      const L = lines(WS[a.path]), s = num(a.start_line), e = num(a.end_line);
      if (!(s >= 1 && s <= L.length + 1 && e >= s - 1 && e <= L.length)) throw new Error('invalid range; file has ' + L.length + ' lines');
      L.splice(s - 1, e - s + 1, ...(a.new_text === '' || a.new_text == null ? [] : lines(String(a.new_text))));
      WS[a.path] = L.join('\n'); return 'ok, ' + a.path + ' now has ' + L.length + ' lines';
    },
    delete_file: (a) => { if (!(a.path in WS)) throw new Error('no such file: ' + a.path); delete WS[a.path]; return 'deleted ' + a.path; },
    web_search: (a) => wsReq({ t: 'tool', name: 'web_search', args: a }).then((r) => r.result),
    scrape_url: (a) => wsReq({ t: 'tool', name: 'scrape_url', args: a }).then((r) => r.result),
  };
  const fn = (name, description, props, req) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties: props, required: req || [] } } });
  const S = { type: 'string' }, N = { type: 'integer' };
  const TOOLS = [
    fn('list_files', 'List all files in the workspace.', {}),
    fn('read_file', 'Read a file with line numbers. Optionally limit to a line range.', { path: S, start_line: N, end_line: N }, ['path']),
    fn('create_file', 'Create a file (or overwrite an existing one) with full content.', { path: S, content: S }, ['path', 'content']),
    fn('edit_lines', 'Replace lines start_line..end_line (1-indexed, inclusive) with new_text. Empty new_text deletes those lines. To insert before line N, use start_line=N and end_line=N-1.', { path: S, start_line: N, end_line: N, new_text: S }, ['path', 'start_line', 'end_line', 'new_text']),
    fn('delete_file', 'Delete a file from the workspace.', { path: S }, ['path']),
    fn('web_search', 'Search the web. Returns titles, urls and snippets.', { query: S }, ['query']),
    fn('scrape_url', 'Fetch a web page and return its readable text and links.', { url: S }, ['url']),
  ];
  const sysPrompt = () => 'You are Gallium, a sharp, concise assistant inside the "gallium lite" browser. You have a persistent text-file workspace and tools: list_files, read_file, create_file, edit_lines, delete_file, web_search, scrape_url. Use tools whenever the user wants files made or changed, or needs fresh information; read a file before editing its lines, and prefer edit_lines for small changes. Format math with LaTeX: $inline$ and $$display$$. Be brief and plain; no emoji.\n\nWorkspace now:\n' + TOOLFN.list_files();

  function tex(t, disp) { try { return window.katex ? window.katex.renderToString(t, { displayMode: disp, throwOnError: false }) : esc(t); } catch (e) { return esc(t); } }
  function md(src) {
    src = src.replace(/<think>[\s\S]*?(?:<\/think>|$)/g, '');
    const st = [], put = (h) => '\u0001' + (st.push(h) - 1) + '\u0001';
    src = src.replace(/```[\w+-]*\n?([\s\S]*?)(?:```|$)/g, (m, c) => put('<pre><code>' + esc(c.replace(/\n$/, '')) + '</code></pre>'));
    src = src.replace(/`([^`\n]+)`/g, (m, c) => put('<code>' + esc(c) + '</code>'));
    src = src.replace(/\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|(?<![\\$\w])\$(?!\s)([^$\n]+?)(?<!\s)\$(?![\d\w])/g, (m, a, b, c, d) => put(tex((a != null ? a : b != null ? b : c != null ? c : d).trim(), a != null || b != null)));
    const h = esc(src).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/(^|[^*])\*(?!\s)(.+?)\*(?!\*)/g, '$1<i>$2</i>').replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>');
    const o = []; let list = null;
    for (const ln of h.split('\n')) {
      let m;
      if ((m = ln.match(/^\s*([-*•]|\d+[.)])\s+(.*)/))) { const t = /\d/.test(m[1]) ? 'ol' : 'ul'; if (list !== t) { if (list) o.push('</' + list + '>'); o.push('<' + t + '>'); list = t; } o.push('<li>' + m[2] + '</li>'); continue; }
      if (list) { o.push('</' + list + '>'); list = null; }
      if ((m = ln.match(/^(#{1,3})\s+(.*)/))) o.push('<h' + (m[1].length + 2) + '>' + m[2] + '</h' + (m[1].length + 2) + '>');
      else if (ln.trim()) o.push('<p>' + ln + '</p>');
    }
    if (list) o.push('</' + list + '>');
    return o.join('').replace(/\u0001(\d+)\u0001/g, (m, i) => st[i]);
  }
  msgs.onclick = (e) => { const a = e.target.closest('.msg a'); if (a) { e.preventDefault(); newTab(a.href); } };
  const down = () => msgs.scrollTo({ top: msgs.scrollHeight, behavior: 'smooth' });
  function addMsg(cls, html) { const d = document.createElement('div'); d.className = 'msg ' + cls; d.innerHTML = '<div class="b">' + html + '</div>'; msgs.appendChild(d); down(); return d; }

  let history = [], busy = false;
  async function agent() {
    busy = true;
    try {
      for (let it = 0; it < 12; it++) {
        const box = addMsg('bot', '<span class="think"><i></i><i></i><i></i></span>'), b = box.firstChild;
        let buf = '', pend2 = 0;
        const r = await wsReq({ t: 'ai', model: cfg.model, messages: [{ role: 'system', content: sysPrompt() }, ...history], tools: TOOLS }, (m) => {
          buf += m.c; if (pend2) return; pend2 = 1;
          requestAnimationFrame(() => { pend2 = 0; b.innerHTML = md(buf) || '<span class="think"><i></i><i></i><i></i></span>'; down(); });
        });
        b.innerHTML = md(r.content || ''); if (!r.content) box.remove();
        const calls = r.tool_calls || [];
        history.push({ role: 'assistant', content: r.content || '', ...(calls.length ? { tool_calls: calls } : {}) });
        if (!calls.length) break;
        for (const tc of calls) {
          let args = {}; try { args = JSON.parse(tc.function.arguments || '{}'); } catch (e) {}
          const label = tc.function.name + ' ' + (args.path || args.query || args.url || '');
          const chip = document.createElement('div'); chip.className = 'tl'; chip.innerHTML = '<i></i>' + esc(label); msgs.appendChild(chip); down();
          let res, ok = true;
          try { if (!TOOLFN[tc.function.name]) throw new Error('unknown tool'); res = String(await TOOLFN[tc.function.name](args)); } catch (e) { ok = false; res = 'Error: ' + e.message; }
          chip.classList.add(ok ? 'ok' : 'err'); saveWs();
          history.push({ role: 'tool', tool_call_id: tc.id, content: res.slice(0, 14000) });
        }
      }
    } catch (e) { addMsg('bot', '<span style="color:#f88">' + esc(e.message) + '</span>'); }
    busy = false;
  }
  const aiin = $('#aiin');
  $('#aif').onsubmit = (e) => { e.preventDefault(); const v = aiin.value.trim(); if (!v || busy) return; aiin.value = ''; aiin.style.height = 'auto'; aiEl.classList.remove('ws'); $('#aiws').classList.remove('on'); addMsg('user', esc(v)); history.push({ role: 'user', content: v }); agent(); };
  aiin.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#aif').requestSubmit(); } };
  aiin.oninput = () => { aiin.style.height = 'auto'; aiin.style.height = Math.min(140, aiin.scrollHeight) + 'px'; };
  $('#aiclr').onclick = () => { history = []; msgs.innerHTML = ''; };
  addMsg('bot', md('hi. i can build files in a workspace, edit specific lines, search the web and read pages. math works too: $e^{i\\pi}+1=0$.'));

  newTab();
}
