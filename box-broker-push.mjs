// Web Push for the login broker (box-broker.mjs), with node:crypto only: VAPID
// (RFC 8292) to sign each request, and aes128gcm (RFC 8291) to encrypt its payload.
// A payload never holds a value; see docs/broker.md.
import { createCipheriv, createECDH, createPrivateKey, generateKeyPairSync, hkdfSync, randomBytes, sign } from 'node:crypto';

const SUB = 'https://github.com/kdpa-llc/agent-box';
const RECORD_SIZE = 4096;

const b64u = buf => Buffer.from(buf).toString('base64url');
const unb64u = text => Buffer.from(String(text || ''), 'base64url');

// A new VAPID key pair, as the private JWK the state file keeps.
export function vapidKeys() {
  return generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ format: 'jwk' });
}

// The public key as the app needs it for pushManager.subscribe: the uncompressed P-256 point.
export function publicKeyOf(jwk) {
  return b64u(Buffer.concat([Buffer.from([4]), unb64u(jwk.x), unb64u(jwk.y)]));
}

// Known push services only, so a phone can't make the broker post to any address.
// Hosts in `extra` (BOX_BROKER_PUSH_HOSTS, for tests) may also use http.
const KNOWN = [h => h.endsWith('.push.apple.com'), h => h === 'fcm.googleapis.com',
  h => h.endsWith('.push.services.mozilla.com'), h => h.endsWith('.notify.windows.com')];
export function pushAllowed(endpoint, extra = []) {
  let u;
  try { u = new URL(endpoint); } catch { return false; }
  if (u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  if (u.protocol === 'https:' && KNOWN.some(known => known(host))) return true;
  return ['https:', 'http:'].includes(u.protocol) && (extra.includes(host) || extra.includes(u.host.toLowerCase()));
}

// The keys a PushSubscription carries, checked: a P-256 point and a 16-byte secret.
export function subscriptionKeysOk(keys) {
  const p256dh = unb64u(keys?.p256dh), auth = unb64u(keys?.auth);
  return p256dh.length === 65 && p256dh[0] === 4 && auth.length === 16;
}

// RFC 8291: one record, so the payload must stay under about 4 KB.
export function encrypt(payload, p256dh, auth) {
  const uaPublic = unb64u(p256dh), authSecret = unb64u(auth);
  const ecdh = createECDH('prime256v1');
  const asPublic = ecdh.generateKeys();
  const shared = ecdh.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const salt = randomBytes(16);
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const plain = Buffer.concat([Buffer.from(payload), Buffer.from([2])]);   // 2: the last record, no padding
  if (plain.length + 16 > RECORD_SIZE) throw Error('push payload too long');
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const sealed = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, sealed]);
}

function vapidHeader(endpoint, jwk) {
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: SUB }));
  const key = createPrivateKey({ key: jwk, format: 'jwk' });
  const signature = sign('sha256', Buffer.from(`${head}.${claims}`), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${head}.${claims}.${b64u(signature)}, k=${publicKeyOf(jwk)}`;
}

// Sends one notification. Returns the push service's HTTP status, or 0 when it
// didn't answer.
export async function sendPush(subscription, message, { jwk, ttl }) {
  const body = encrypt(JSON.stringify(message), subscription.keys.p256dh, subscription.keys.auth);
  const response = await fetch(subscription.endpoint, {
    method: 'POST', body, redirect: 'error', signal: AbortSignal.timeout(10_000),
    headers: { TTL: String(Math.max(0, Math.ceil(ttl))), Urgency: 'high', 'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream', Authorization: vapidHeader(subscription.endpoint, jwk) },
  }).catch(() => null);
  if (!response) return 0;
  await response.arrayBuffer().catch(() => {});
  return response.status;
}
