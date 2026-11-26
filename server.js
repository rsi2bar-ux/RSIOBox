// ANGEL ONE SNIPER BACKEND — SmartAPI (REST) -> index candles, option-chain LTP/OI, strike candles, push alerts.
// Zero npm dependencies (Node 18+). Read-only: never places orders.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { totp } from "./totp.js";
import { sendPush, generateVapidKeys } from "./webpush.js";

const ENV = process.env;
const PORT = Number(ENV.PORT || 8080);
const API = (ENV.ANGEL_BASE || "https://apiconnect.angelone.in").replace(/\/+$/, "");
const SCRIP_URL = ENV.SCRIP_URL || "https://margincalculator.angelbroking.com/OpenAPI_Files/OpenAPIScripMaster.json";
const CFG = { apiKey: ENV.ANGEL_API_KEY || "", client: ENV.ANGEL_CLIENT_CODE || "", pin: ENV.ANGEL_PIN || "", secret: ENV.ANGEL_TOTP_SECRET || "" };
const CHAIN_STRIKES = Math.max(5, Math.min(40, Number(ENV.CHAIN_STRIKES || 20)));
const CHAIN_SEC = Math.max(3, Number(ENV.CHAIN_SEC || 5));
const DATA_DIR = ENV.DATA_DIR || "";
const VERSION = "angel-sniper-1.0";
const now = () => Date.now();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = { info: (...a) => console.log(new Date().toISOString(), ...a), warn: (...a) => console.warn(new Date().toISOString(), "WARN", ...a) };

const INDEXES = {
  NIFTY: { name: "NIFTY", exch: "NSE", token: "99926000", optExch: "NFO" },
  BANKNIFTY: { name: "BANKNIFTY", exch: "NSE", token: "99926009", optExch: "NFO" },
  SENSEX: { name: "SENSEX", exch: "BSE", token: "99919000", optExch: "BFO" }
};
const TF = { "1m": ["ONE_MINUTE", 60000, 5], "3m": ["THREE_MINUTE", 180000, 10], "5m": ["FIVE_MINUTE", 300000, 20], "15m": ["FIFTEEN_MINUTE", 900000, 60], "30m": ["THIRTY_MINUTE", 1800000, 90], "60m": ["ONE_HOUR", 3600000, 120] };

// ------------------------------------------------------------ files
const dataOn = () => { try { if (!DATA_DIR) return false; fs.mkdirSync(DATA_DIR, { recursive: true }); return true; } catch { return false; } };
const readJson = f => { try { return dataOn() ? JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), "utf8")) : null; } catch { return null; } };
const writeJson = (f, v) => { try { if (dataOn()) fs.writeFileSync(path.join(DATA_DIR, f), JSON.stringify(v)); } catch {} };

// ------------------------------------------------------------ IST helpers
const IST = ms => { const d = new Date(ms + 19800000); return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), dow: d.getUTCDay() }; };
const p2 = n => String(n).padStart(2, "0");
const istStr = ms => { const t = IST(ms); return `${t.y}-${p2(t.mo)}-${p2(t.d)} ${p2(t.h)}:${p2(t.mi)}`; };
const MON = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
function parseExpiry(s) { const m = /^(\d{1,2})([A-Za-z]{3})(\d{4})$/.exec(String(s || "").trim()); if (!m) return NaN; const mo = MON.indexOf(m[2].toUpperCase()); if (mo < 0) return NaN; return Date.UTC(+m[3], mo, +m[1]) - 19800000 + 15.5 * 3600000; }
function parseFeed(s) { if (!s) return NaN; const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})$/.exec(String(s).trim()); if (m) { const mo = MON.indexOf(m[2].toUpperCase()); return Date.UTC(+m[3], mo, +m[1], +m[4], +m[5], +m[6]) - 19800000; } const t = Date.parse(s); return isNaN(t) ? NaN : t; }
function phaseClock(t = now()) {
  if (ENV.FORCE_PHASE === "open") return { phase: "OPEN", open: true, label: "Market LIVE" };
  if (ENV.FORCE_PHASE === "closed") return { phase: "CLOSED", open: false, label: "Market closed" };
  const x = IST(t), mins = x.h * 60 + x.mi, wk = x.dow >= 1 && x.dow <= 5;
  if (!wk) return { phase: "WEEKEND", open: false, label: "Market closed (weekend)" };
  if (mins >= 555 && mins < 930) return { phase: "OPEN", open: true, label: "Market LIVE" };
  if (mins >= 540 && mins < 555) return { phase: "PREOPEN", open: false, label: "Pre-open" };
  return { phase: "CLOSED", open: false, label: mins < 540 ? "Market opens 09:15" : "Market closed" };
}

// ------------------------------------------------------------ Angel One session
const auth = { jwt: "", refresh: "", feed: "", at: 0, error: "", status: "NO_LOGIN", busy: null };
const baseHeaders = () => ({ "Content-Type": "application/json", Accept: "application/json", "X-UserType": "USER", "X-SourceID": "WEB", "X-ClientLocalIP": "127.0.0.1", "X-ClientPublicIP": "127.0.0.1", "X-MACAddress": "00:00:00:00:00:00", "X-PrivateKey": CFG.apiKey });
async function rawPost(p, body, jwt) {
  const h = baseHeaders(); if (jwt) h.Authorization = "Bearer " + jwt;
  const c = new AbortController(), t = setTimeout(() => c.abort(), 15000);
  try { const r = await fetch(API + p, { method: "POST", headers: h, body: JSON.stringify(body), signal: c.signal }); let j = null; try { j = await r.json(); } catch {} return { http: r.status, j }; }
  finally { clearTimeout(t); }
}
async function login() {
  if (auth.busy) return auth.busy;
  auth.busy = (async () => {
    try {
      if (!CFG.apiKey || !CFG.client || !CFG.pin || !CFG.secret) throw new Error("Set ANGEL_API_KEY, ANGEL_CLIENT_CODE, ANGEL_PIN, ANGEL_TOTP_SECRET");
      const r = await rawPost("/rest/auth/angelbroking/user/v1/loginByPassword", { clientcode: CFG.client, password: CFG.pin, totp: totp(CFG.secret) });
      if (!r.j || r.j.status !== true || !r.j.data?.jwtToken) throw new Error("login failed: " + (r.j?.message || r.http) + (r.j?.errorcode ? " [" + r.j.errorcode + "]" : ""));
      auth.jwt = r.j.data.jwtToken; auth.refresh = r.j.data.refreshToken || ""; auth.feed = r.j.data.feedToken || ""; auth.at = now(); auth.error = ""; auth.status = "LOGGED_IN";
      log.info("Angel One login ok");
    } catch (e) { auth.error = e.message; auth.status = "ERROR"; log.warn("login", e.message); throw e; }
    finally { setTimeout(() => { auth.busy = null; }, 0); }
  })();
  return auth.busy;
}
const needLogin = r => r.http === 401 || r.http === 403 || ["AG8001", "AG8002", "AB8050", "AB8051", "AB1010"].includes(r.j?.errorcode);
async function secure(p, body) {
  if (!auth.jwt || now() - auth.at > 20 * 3600000) await login();
  let r = await rawPost(p, body, auth.jwt);
  if (needLogin(r)) { await login(); r = await rawPost(p, body, auth.jwt); }
  if (r.http === 429 || /access rate/i.test(r.j?.message || "")) throw Object.assign(new Error("rate-limited"), { rate: true });
  if (!r.j || r.j.status === false) throw new Error((r.j?.message || "HTTP " + r.http) + (r.j?.errorcode ? " [" + r.j.errorcode + "]" : ""));
  return r.j.data;
}
// serial queues with a minimum gap (SmartAPI: quote ~1/s, historical ~3/s)
function makeQueue(gap) { let tail = Promise.resolve(), last = 0; return fn => { const run = tail.then(async () => { const w = last + gap - now(); if (w > 0) await sleep(w); try { return await fn(); } finally { last = now(); } }); tail = run.catch(() => {}); return run; }; }
const qQuote = makeQueue(1100), qHist = makeQueue(380);
const retry = async (fn, n = 2) => { let e; for (let i = 0; i <= n; i++) { try { return await fn(); } catch (x) { e = x; if (x.rate) await sleep(1500 * (i + 1)); else if (i < n) await sleep(400); } } throw e; };

// ------------------------------------------------------------ instruments
const M = { loadedAt: 0, rows: [], byIdx: {} };
async function loadMaster(force) {
  if (!force && M.rows.length && now() - M.loadedAt < 12 * 3600000) return;
  const j = await (await fetch(SCRIP_URL, { signal: AbortSignal.timeout(60000) })).json();
  const keep = j.filter(r => (r.instrumenttype === "OPTIDX" || r.instrumenttype === "FUTIDX") && ["NFO", "BFO"].includes(r.exch_seg) && INDEXES[r.name]);
  M.rows = keep; M.loadedAt = now(); M.byIdx = {};
  for (const k of Object.keys(INDEXES)) {
    const opts = keep.filter(r => r.name === k && r.instrumenttype === "OPTIDX").map(r => ({ token: String(r.token), symbol: r.symbol, strike: Number(r.strike) / 100, type: /CE$/.test(r.symbol) ? "CE" : "PE", exp: parseExpiry(r.expiry), expiry: r.expiry, lot: Number(r.lotsize) || 0, exch: r.exch_seg })).filter(r => isFinite(r.exp));
    const futs = keep.filter(r => r.name === k && r.instrumenttype === "FUTIDX").map(r => ({ token: String(r.token), symbol: r.symbol, exp: parseExpiry(r.expiry), expiry: r.expiry, exch: r.exch_seg })).filter(r => isFinite(r.exp)).sort((a, b) => a.exp - b.exp);
    M.byIdx[k] = { opts, expiries: [...new Set(opts.map(o => o.expiry))].sort((a, b) => parseExpiry(a) - parseExpiry(b)).filter(e => parseExpiry(e) >= now() - 6 * 3600000), futs: futs.filter(f => f.exp >= now() - 6 * 3600000) };
  }
  log.info("Scrip master", keep.length, "rows");
}

// ------------------------------------------------------------ state
const S = { index: ENV.INDEX || "NIFTY", expiry: ENV.EXPIRY || "", spot: null, prevClose: null, feedAt: 0, chain: { rows: [], atm: null, at: 0, expiry: "" }, last: readJson("last-session.json"), chainBusy: false, startedAt: now(), restOk: 0, restErr: 0, lastErr: "" };
const IDX = () => INDEXES[S.index];
function activeExpiry() { const m = M.byIdx[S.index]; if (!m) return ""; if (S.expiry && m.expiries.includes(S.expiry)) return S.expiry; return m.expiries[0] || ""; }

function phaseNow() {
  const c = phaseClock();
  if (c.open && S.feedAt && now() - S.feedAt > 10 * 60000) return { phase: "STALE", open: false, label: "Market closed (no fresh ticks — holiday?)" };
  return c;
}

// ------------------------------------------------------------ quotes / chain
async function quoteFull(map) { // map: {NSE:[tokens], NFO:[tokens]}
  return qQuote(() => retry(async () => { const d = await secure("/rest/secure/angelbroking/market/v1/quote/", { mode: "FULL", exchangeTokens: map }); S.restOk++; return d?.fetched || []; }));
}
async function refreshChain() {
  if (S.chainBusy) return; S.chainBusy = true;
  try {
    await loadMaster();
    const ix = IDX(), exp = activeExpiry(), m = M.byIdx[S.index]; if (!exp) throw new Error("no expiry for " + S.index);
    if (S.spot == null) { const f = await quoteFull({ [ix.exch]: [ix.token] }); const q = f[0]; if (q) applySpot(q); }
    if (S.spot == null) throw new Error("no spot");
    const list = m.opts.filter(o => o.expiry === exp);
    const strikes = [...new Set(list.map(o => o.strike))].sort((a, b) => a - b);
    let ai = 0; strikes.forEach((k, i) => { if (Math.abs(k - S.spot) < Math.abs(strikes[ai] - S.spot)) ai = i; });
    const pick = strikes.slice(Math.max(0, ai - CHAIN_STRIKES), ai + CHAIN_STRIKES + 1), atm = strikes[ai];
    const sel = list.filter(o => pick.includes(o.strike));
    const byTok = new Map(sel.map(o => [o.token, o])), toks = sel.map(o => o.token), rows = [];
    for (let i = 0; i < toks.length; i += 49) {
      const chunk = toks.slice(i, i + 49), map = { [ix.optExch]: chunk }; if (i === 0) map[ix.exch] = [ix.token];
      const f = await quoteFull(map);
      for (const q of f) {
        if (String(q.symbolToken) === ix.token && q.exchange === ix.exch) { applySpot(q); continue; }
        const o = byTok.get(String(q.symbolToken)); if (!o) continue;
        const ltp = Number(q.ltp), cl = Number(q.close);
        rows.push({ strike: o.strike, type: o.type, token: o.token, exch: o.exch, symbol: o.symbol, ltp, close: isFinite(cl) ? cl : null, chg: isFinite(cl) && cl > 0 ? +(ltp - cl).toFixed(2) : null, chgPct: isFinite(cl) && cl > 0 ? +((ltp - cl) / cl * 100).toFixed(2) : null, oi: Number(q.opnInterest) || 0, volume: Number(q.tradeVolume) || 0, lot: o.lot, feedAt: parseFeed(q.exchFeedTime) || null });
      }
    }
    if (rows.length) {
      rows.sort((a, b) => a.strike - b.strike || (a.type < b.type ? -1 : 1));
      S.chain = { rows, atm, at: now(), expiry: exp };
      const ph = phaseClock(); if (ph.open || !S.last) { S.last = { index: S.index, spot: S.spot, prevClose: S.prevClose, rows, atm, expiry: exp, at: now(), feedAt: S.feedAt }; writeJson("last-session.json", S.last); }
    }
  } catch (e) { S.restErr++; S.lastErr = e.message; log.warn("chain", e.message); }
  finally { S.chainBusy = false; }
}
function applySpot(q) { const v = Number(q.ltp); if (isFinite(v) && v > 0) { S.spot = v; const c = Number(q.close); S.prevClose = isFinite(c) && c > 0 ? c : S.prevClose; const ft = parseFeed(q.exchFeedTime); S.feedAt = isFinite(ft) ? ft : now(); } }

// ------------------------------------------------------------ candles
const candleCache = new Map(), inflight = new Map();
async function candles(exch, token, tf) {
  const def = TF[tf]; if (!def) throw new Error("bad tf " + tf);
  const key = exch + "|" + token + "|" + tf, ph = phaseClock(), ttl = ph.open ? 3000 : 180000, c = candleCache.get(key);
  if (c && now() - c.at < ttl) return c.data;
  if (inflight.has(key)) return inflight.get(key);
  const p = qHist(() => retry(async () => {
    const days = def[2], to = now();
    const d = await secure("/rest/secure/angelbroking/historical/v1/getCandleData", { exchange: exch, symboltoken: String(token), interval: def[0], fromdate: istStr(to - days * 86400000).slice(0, 10) + " 09:15", todate: istStr(to) });
    S.restOk++;
    const out = (Array.isArray(d) ? d : []).map(r => ({ time: Date.parse(r[0]), open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5] || 0 })).filter(r => isFinite(r.time) && isFinite(r.close));
    candleCache.set(key, { at: now(), data: out }); if (candleCache.size > 400) candleCache.delete(candleCache.keys().next().value);
    return out;
  })).finally(() => inflight.delete(key));
  inflight.set(key, p); return p;
}

// ------------------------------------------------------------ push
const VAPID = (() => { let v = { publicKey: ENV.VAPID_PUBLIC_KEY || "", privateKey: ENV.VAPID_PRIVATE_KEY || "", subject: ENV.VAPID_SUBJECT || "mailto:admin@example.com", source: "env" }; if (!v.publicKey || !v.privateKey) { const f = readJson("vapid.json"); if (f?.publicKey) v = { ...v, ...f, source: "file" }; else { const g = generateVapidKeys(); v = { ...v, ...g, source: "generated" }; writeJson("vapid.json", g); } } return v; })();
const pushSubs = new Map(); (readJson("push-subs.json") || []).forEach(s => s?.endpoint && pushSubs.set(s.endpoint, s));
async function pushAll(payload) {
  let sent = 0, failed = 0;
  for (const [ep, sub] of pushSubs) { try { await sendPush(sub, payload, VAPID, { ttl: 120, urgency: "high" }); sent++; } catch (e) { failed++; if ([404, 410].includes(e.statusCode)) pushSubs.delete(ep); } }
  writeJson("push-subs.json", [...pushSubs.values()]); return { sent, failed, devices: pushSubs.size };
}

// ------------------------------------------------------------ http
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "Content-Type" };
const send = (res, code, obj) => { const b = JSON.stringify(obj); res.writeHead(code, { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(b); };
const readBody = req => new Promise(r => { let s = ""; req.on("data", c => { s += c; if (s.length > 2e6) req.destroy(); }); req.on("end", () => { try { r(JSON.parse(s || "{}")); } catch { r({}); } }); });
function overview() {
  const ph = phaseNow(), m = M.byIdx[S.index], fut = m?.futs?.[0];
  return { ok: true, version: VERSION, index: S.index, indexes: Object.keys(INDEXES), expiry: activeExpiry(), expiries: m?.expiries?.slice(0, 6) || [], spot: S.spot, prevClose: S.prevClose, change: S.spot != null && S.prevClose ? +(S.spot - S.prevClose).toFixed(2) : null, changePct: S.spot != null && S.prevClose ? +((S.spot - S.prevClose) / S.prevClose * 100).toFixed(2) : null,
    market: { open: ph.open, phase: ph.phase, label: ph.label }, feedAt: S.feedAt || null, chainAt: S.chain.at || null, serverTime: now(), fut: fut ? { exch: fut.exch, token: fut.token, symbol: fut.symbol } : null,
    spotToken: { exch: IDX().exch, token: IDX().token }, lastSession: S.last ? { at: S.last.at, spot: S.last.spot, index: S.last.index } : null, auth: auth.status };
}
const routes = {
  "GET /health": async (q, res) => send(res, 200, { ok: true, version: VERSION, uptime: Math.round((now() - S.startedAt) / 1000) }),
  "GET /api/health": async (q, res) => send(res, 200, { ok: true, version: VERSION, auth: auth.status, authError: auth.error || null, master: M.rows.length, chainRows: S.chain.rows.length, chainAt: S.chain.at || null, restOk: S.restOk, restErr: S.restErr, lastError: S.lastErr || null, market: phaseNow(), vapid: !!VAPID.publicKey, pushDevices: pushSubs.size, serverTime: now(), uptimeSec: Math.round((now() - S.startedAt) / 1000) }),
  "GET /api/overview": async (q, res) => send(res, 200, overview()),
  "GET /api/config": async (q, res) => send(res, 200, { ok: true, version: VERSION, indexes: Object.keys(INDEXES), timeframes: Object.keys(TF), chainStrikes: CHAIN_STRIKES }),
  "GET /api/expiries": async (q, res) => send(res, 200, { ok: true, index: S.index, active: activeExpiry(), expiries: M.byIdx[S.index]?.expiries || [] }),
  "POST /api/index": async (q, res, body) => { const k = String(body.index || "").toUpperCase(); if (!INDEXES[k]) return send(res, 400, { ok: false, error: "unknown index" }); if (k !== S.index) { S.index = k; S.spot = null; S.prevClose = null; S.feedAt = 0; S.chain = { rows: [], atm: null, at: 0, expiry: "" }; S.expiry = ""; } if (body.expiry) S.expiry = String(body.expiry); refreshChain(); send(res, 200, { ok: true, index: S.index, expiry: activeExpiry() }); },
  "GET /api/candles": async (q, res) => { const tf = q.get("tf") || "3m", ix = IDX(); const exch = q.get("exch") || ix.exch, token = q.get("token") || ix.token, limit = Math.min(1500, Number(q.get("limit") || 700)); const d = await candles(exch, token, tf); send(res, 200, { ok: true, tf, exch, token, count: d.length, data: d.slice(-limit) }); },
  "GET /api/option-chain": async (q, res) => { if (!S.chain.rows.length && !S.chainBusy) await refreshChain(); const ph = phaseNow(); const useLast = !S.chain.rows.length && S.last && S.last.index === S.index; const src = useLast ? S.last : { ...S.chain, spot: S.spot }; send(res, 200, { ok: true, index: S.index, expiry: src.expiry || S.chain.expiry, spot: useLast ? S.last.spot : S.spot, prevClose: S.prevClose, rows: src.rows || [], analytics: { atm: src.atm, spot: S.spot }, at: src.at || S.chain.at, fromLastSession: useLast, market: { open: ph.open, phase: ph.phase, label: ph.label } }); },
  "GET /api/last-session": async (q, res) => send(res, 200, { ok: true, last: S.last }),
  "GET /api/push/vapid": async (q, res) => send(res, 200, { ok: true, publicKey: VAPID.publicKey, source: VAPID.source }),
  "POST /api/push/subscribe": async (q, res, b) => { const s = b.subscription || b; if (!s?.endpoint || !s?.keys?.p256dh) return send(res, 400, { ok: false, error: "invalid subscription" }); pushSubs.set(s.endpoint, { endpoint: s.endpoint, keys: s.keys, at: now(), label: String(b.label || "").slice(0, 40) }); while (pushSubs.size > 50) pushSubs.delete(pushSubs.keys().next().value); writeJson("push-subs.json", [...pushSubs.values()]); send(res, 200, { ok: true, devices: pushSubs.size }); },
  "POST /api/push/test": async (q, res) => send(res, 200, { ok: true, ...(await pushAll({ title: "Angel Sniper test", body: "Push alerts working on this phone.", tag: "test", sound: "call" })) }),
  "POST /api/push/signal": async (q, res, b) => { const r = await pushAll({ title: String(b.title || "Signal").slice(0, 120), body: String(b.body || "").slice(0, 300), tag: b.tag || "sig", sound: b.sound || "call" }); send(res, 200, { ok: true, ...r }); }
};
const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") { res.writeHead(204, CORS); return res.end(); }
  const u = new URL(req.url, "http://x"), key = req.method + " " + u.pathname.replace(/\/+$/, "");
  const h = routes[key] || (u.pathname === "/" ? routes["GET /health"] : null);
  if (!h) return send(res, 404, { ok: false, error: "not found" });
  try { const body = req.method === "POST" ? await readBody(req) : null; await h(u.searchParams, res, body); }
  catch (e) { S.restErr++; S.lastErr = e.message; if (!res.headersSent) send(res, 502, { ok: false, error: e.message }); }
});

// ------------------------------------------------------------ boot
async function boot() {
  server.listen(PORT, () => log.info(VERSION, "listening on", PORT));
  try { await loadMaster(true); } catch (e) { log.warn("master", e.message); }
  try { await login(); } catch {}
  refreshChain();
  setInterval(() => { const ph = phaseClock(); const gap = ph.open ? CHAIN_SEC * 1000 : 300000; if (now() - (S.chain.at || 0) >= gap - 500) refreshChain(); }, 1000);
  setInterval(() => { loadMaster(true).catch(() => {}); }, 6 * 3600000);
}
process.on("unhandledRejection", e => log.warn("unhandled", e?.message || e));
if (!process.env.NO_BOOT) boot();
export { totp };
