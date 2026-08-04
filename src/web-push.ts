/**
 * The Web Push protocol, hand-rolled on WebCrypto so the app keeps its
 * runtime-dependency-free footprint.
 *
 * Two independent halves, per the specs:
 *   - VAPID (RFC 8292): a signed JWT that identifies this server to the push
 *     service so it accepts the message. Uses an ECDSA P-256 keypair.
 *   - Message encryption (RFC 8291 over the aes128gcm content encoding of
 *     RFC 8188): the payload is encrypted to the subscription's own keys, so
 *     not even the push service can read it. Uses an ephemeral ECDH P-256
 *     keypair per message.
 *
 * The two keypairs are different algorithms and must not be conflated: the
 * VAPID key only signs; the ephemeral key only does key agreement.
 */

export type PushSubscription = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
};

export type VapidKeys = {
  /** Raw uncompressed public point (65 bytes), base64url — the applicationServerKey. */
  publicKey: string;
  /** Private key as JWK, for re-import to sign. */
  privateJwk: JsonWebKey;
};

// --- base64url --------------------------------------------------------------

const enc = new TextEncoder();

/**
 * WebCrypto and fetch types (lib.dom) demand ArrayBuffer-backed views, while
 * TypeScript's generic `Uint8Array` widens to `ArrayBufferLike`. Our arrays are
 * always ArrayBuffer-backed at runtime; narrow the type back at the boundary.
 */
function src(u: Uint8Array): BufferSource {
  return u as unknown as BufferSource;
}

export function bytesToB64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function u32be(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, false);
  return b;
}

// --- VAPID ------------------------------------------------------------------

export async function generateVapidKeys(): Promise<VapidKeys> {
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const pubRaw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  const privateJwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
  return { publicKey: bytesToB64url(pubRaw), privateJwk };
}

function b64urlJson(obj: unknown): string {
  return bytesToB64url(enc.encode(JSON.stringify(obj)));
}

/**
 * The `Authorization: vapid t=<jwt>, k=<key>` header the push service checks.
 *
 * `nowMs` is a parameter so a test gets a fixed `exp`; production passes
 * `Date.now()`.
 */
export async function vapidAuthHeader(
  endpoint: string,
  keys: VapidKeys,
  subject: string,
  nowMs: number,
): Promise<string> {
  const aud = new URL(endpoint).origin;
  const exp = Math.floor(nowMs / 1000) + 12 * 3600; // <= 24h, per RFC 8292
  const header = b64urlJson({ typ: "JWT", alg: "ES256" });
  const payload = b64urlJson({ aud, exp, sub: subject });
  const signingInput = `${header}.${payload}`;

  const priv = await crypto.subtle.importKey(
    "jwk",
    keys.privateJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  // WebCrypto returns the raw r||s signature ECDSA JWTs expect.
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, priv, src(enc.encode(signingInput))),
  );
  return `vapid t=${signingInput}.${bytesToB64url(sig)}, k=${keys.publicKey}`;
}

// --- message encryption -----------------------------------------------------

/** HKDF (extract+expand in one WebCrypto call) → `length` bytes. */
async function hkdf(
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", src(ikm), "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: src(salt), info: src(info) },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

/** Test seam: fixed salt and ephemeral key make the output deterministic. */
export type EncryptOpts = { salt?: Uint8Array; ephemeral?: CryptoKeyPair };

/**
 * Encrypts `plaintext` to a subscription, returning the aes128gcm body to POST.
 *
 * Body layout (RFC 8188): salt(16) | rs(4) | idlen(1)=65 | keyid(65=as_public)
 * followed by the AES-128-GCM ciphertext of `plaintext || 0x02`.
 */
export async function encryptPayload(
  sub: PushSubscription,
  plaintext: Uint8Array,
  opts: EncryptOpts = {},
): Promise<Uint8Array> {
  const uaPublic = b64urlToBytes(sub.keys.p256dh); // 65 bytes
  const authSecret = b64urlToBytes(sub.keys.auth); // 16 bytes
  const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(16));

  const asKp =
    opts.ephemeral ??
    (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]));
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", asKp.publicKey)); // 65

  const uaKey = await crypto.subtle.importKey(
    "raw",
    src(uaPublic),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, asKp.privateKey, 256),
  );

  // RFC 8291 §3.4: combine the ECDH secret with the auth secret.
  const keyInfo = concat(enc.encode("WebPush: info\0"), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, shared, keyInfo, 32);

  // RFC 8188: derive the content-encryption key and nonce from the record salt.
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);

  const cekKey = await crypto.subtle.importKey("raw", src(cek), { name: "AES-GCM" }, false, [
    "encrypt",
  ]);
  // One record: a 0x02 delimiter marks it as the last, with no further padding.
  const record = concat(plaintext, Uint8Array.of(2));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: src(nonce), tagLength: 128 },
      cekKey,
      src(record),
    ),
  );

  const header = concat(salt, u32be(4096), Uint8Array.of(asPublic.length), asPublic);
  return concat(header, ciphertext);
}

// --- send -------------------------------------------------------------------

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Encrypts and POSTs one notification to one subscription's endpoint.
 *
 * `fetchImpl` is injectable so tests assert what would be sent without a
 * network. The caller inspects the status: 404/410 means the subscription is
 * gone and should be dropped.
 */
export async function sendPush(
  sub: PushSubscription,
  keys: VapidKeys,
  payload: unknown,
  subject: string,
  nowMs: number,
  fetchImpl: Fetch = fetch,
): Promise<Response> {
  const body = await encryptPayload(sub, enc.encode(JSON.stringify(payload)));
  const auth = await vapidAuthHeader(sub.endpoint, keys, subject, nowMs);
  return await fetchImpl(sub.endpoint, {
    method: "POST",
    headers: {
      Authorization: auth,
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: "2419200",
    },
    body: src(body),
  });
}
