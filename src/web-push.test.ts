import { test, expect } from "bun:test";
import {
  generateVapidKeys,
  vapidAuthHeader,
  encryptPayload,
  bytesToB64url,
  b64urlToBytes,
  type PushSubscription,
} from "./web-push";

const enc = new TextEncoder();
const dec = new TextDecoder();

// Same boundary cast the module uses: WebCrypto wants ArrayBuffer-backed views.
const src = (u: Uint8Array): BufferSource => u as unknown as BufferSource;

test("base64url round-trips arbitrary bytes", () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 251, 255, 62, 63]);
  expect(b64urlToBytes(bytesToB64url(bytes))).toEqual(bytes);
});

// Mirror of the module's HKDF, so the test can decrypt independently.
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number) {
  const key = await crypto.subtle.importKey("raw", src(ikm), "HKDF", false, ["deriveBits"]);
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: src(salt), info: src(info) },
      key,
      length * 8,
    ),
  );
}

function concat(...parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) (out.set(p, off), (off += p.length));
  return out;
}

// A subscriber: an ECDH keypair plus a 16-byte auth secret, exactly what a
// browser hands the server on subscribe.
async function makeSubscriber() {
  const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ]);
  const p256dh = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const sub: PushSubscription = {
    endpoint: "https://push.example.com/abc123",
    keys: { p256dh: bytesToB64url(p256dh), auth: bytesToB64url(auth) },
  };
  return { sub, uaPrivate: kp.privateKey, auth };
}

// Independent decrypt, so a passing round-trip proves the ECDH+HKDF+GCM
// pipeline is built to spec rather than merely self-consistent with itself.
async function decrypt(body: Uint8Array, uaPrivate: CryptoKey, uaPublic: Uint8Array, auth: Uint8Array) {
  const salt = body.slice(0, 16);
  const idlen = body[20]!;
  const asPublic = body.slice(21, 21 + idlen);
  const ciphertext = body.slice(21 + idlen);

  const asKey = await crypto.subtle.importKey(
    "raw",
    src(asPublic),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: asKey }, uaPrivate, 256),
  );
  const ikm = await hkdf(auth, shared, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", src(cek), { name: "AES-GCM" }, false, ["decrypt"]);
  const record = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: src(nonce), tagLength: 128 },
      key,
      src(ciphertext),
    ),
  );
  // Strip the trailing 0x02 delimiter of the single record.
  return dec.decode(record.slice(0, -1));
}

test("encryptPayload produces a body the subscriber can decrypt", async () => {
  const { sub, uaPrivate, auth } = await makeSubscriber();
  const uaPublic = b64urlToBytes(sub.keys.p256dh);
  const message = "PROJ-1042 聊完了，在等你";

  const body = await encryptPayload(sub, enc.encode(message));

  // Header layout: salt(16) rs(4) idlen(1)=65 keyid(65).
  expect(body[20]).toBe(65);
  const rs = new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0, false);
  expect(rs).toBe(4096);

  expect(await decrypt(body, uaPrivate, uaPublic, auth)).toBe(message);
});

test("a fixed salt and ephemeral key make encryption deterministic", async () => {
  const { sub } = await makeSubscriber();
  const salt = new Uint8Array(16).fill(7);
  const ephemeral = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ]);
  const opts = { salt, ephemeral };
  const a = await encryptPayload(sub, enc.encode("hi"), opts);
  const b = await encryptPayload(sub, enc.encode("hi"), opts);
  expect(bytesToB64url(a)).toBe(bytesToB64url(b));
});

test("vapidAuthHeader signs a verifiable ES256 JWT with the right claims", async () => {
  const keys = await generateVapidKeys();
  const header = await vapidAuthHeader("https://push.example.com/xyz", keys, "mailto:me@x", 1_700_000_000_000);

  const m = header.match(/^vapid t=([^,]+), k=(.+)$/);
  expect(m).not.toBeNull();
  const [, jwt, k] = m!;
  expect(k).toBe(keys.publicKey);

  const [h, p, sig] = jwt!.split(".");
  const headerObj = JSON.parse(dec.decode(b64urlToBytes(h!)));
  const payloadObj = JSON.parse(dec.decode(b64urlToBytes(p!)));
  expect(headerObj).toEqual({ typ: "JWT", alg: "ES256" });
  expect(payloadObj.aud).toBe("https://push.example.com");
  expect(payloadObj.sub).toBe("mailto:me@x");
  expect(payloadObj.exp).toBe(Math.floor(1_700_000_000_000 / 1000) + 12 * 3600);

  // The signature verifies against the advertised public key.
  const pub = await crypto.subtle.importKey(
    "raw",
    src(b64urlToBytes(k!)),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const ok = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    pub,
    src(b64urlToBytes(sig!)),
    src(enc.encode(`${h}.${p}`)),
  );
  expect(ok).toBe(true);
});
