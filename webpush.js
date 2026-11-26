// Web Push (RFC 8291 aes128gcm + RFC 8292 VAPID) with node:crypto only.
import crypto from "node:crypto";
const b64u = b => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64u = s => Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64");
const hmac = (k, d) => crypto.createHmac("sha256", k).update(d).digest();
export function generateVapidKeys() {
  const e = crypto.createECDH("prime256v1"); e.generateKeys();
  return { publicKey: b64u(e.getPublicKey()), privateKey: b64u(e.getPrivateKey()) };
}
function privKeyObject(pub, priv) {
  const p = fromB64u(pub);
  return crypto.createPrivateKey({ key: { kty: "EC", crv: "P-256", d: b64u(fromB64u(priv)), x: b64u(p.subarray(1, 33)), y: b64u(p.subarray(33, 65)) }, format: "jwk" });
}
export function vapidJwt(endpoint, subject, pub, priv, ttlSec = 12 * 3600) {
  const aud = new URL(endpoint).origin;
  const head = b64u(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const body = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + ttlSec, sub: subject }));
  const sig = crypto.sign("sha256", Buffer.from(head + "." + body), { key: privKeyObject(pub, priv), dsaEncoding: "ieee-p1363" });
  return head + "." + body + "." + b64u(sig);
}
export function encryptPayload(sub, payload) {
  const uaPub = fromB64u(sub.keys.p256dh), auth = fromB64u(sub.keys.auth);
  const e = crypto.createECDH("prime256v1"); e.generateKeys(); const asPub = e.getPublicKey();
  const shared = e.computeSecret(uaPub);
  const prkKey = hmac(auth, shared);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from("WebPush: info\0"), uaPub, asPub, Buffer.from([1])]));
  const salt = crypto.randomBytes(16);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.concat([Buffer.from("Content-Encoding: aes128gcm\0"), Buffer.from([1])])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([Buffer.from("Content-Encoding: nonce\0"), Buffer.from([1])])).subarray(0, 12);
  const c = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  const ct = Buffer.concat([c.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPub.length]), asPub, ct]);
}
export async function sendPush(sub, payload, { publicKey, privateKey, subject }, { ttl = 120, urgency = "high", topic } = {}) {
  const body = encryptPayload(sub, typeof payload === "string" ? payload : JSON.stringify(payload));
  const headers = { "Content-Type": "application/octet-stream", "Content-Encoding": "aes128gcm", TTL: String(ttl), Urgency: urgency, Authorization: "vapid t=" + vapidJwt(sub.endpoint, subject, publicKey, privateKey) + ", k=" + publicKey };
  if (topic) headers.Topic = String(topic).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32);
  const r = await fetch(sub.endpoint, { method: "POST", headers, body });
  if (r.status >= 400) { const t = await r.text().catch(() => ""); const err = new Error("push " + r.status + " " + t.slice(0, 120)); err.statusCode = r.status; throw err; }
  return r.status;
}
export const _test = { fromB64u, b64u, hmac };
