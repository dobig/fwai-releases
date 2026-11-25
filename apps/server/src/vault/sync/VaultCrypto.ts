// Vault sync cryptography. Only environments run this; the relay and clients never do.
// Entries: AES-256-GCM under the vault key, bound to entry id and key generation.
// Sealing the vault key to an environment: ephemeral X25519 + HKDF-SHA256 + AES-256-GCM.
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no X25519 or HKDF.
import * as NodeCrypto from "node:crypto";

const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const SEAL_INFO = "fwai-vault-seal:v1";

const toB64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const fromB64 = (text: string) => new Uint8Array(Buffer.from(text, "base64url"));

export interface VaultKeyPair {
  /** base64url of the raw 32-byte X25519 public key; what the relay stores. */
  readonly publicKey: string;
  /** base64url of the raw 32-byte X25519 private key; kept in the secret store only. */
  readonly privateKey: string;
}

export function generateVaultKey(): Uint8Array {
  return new Uint8Array(NodeCrypto.randomBytes(KEY_BYTES));
}

export function generateKeyPair(): VaultKeyPair {
  const { publicKey, privateKey } = NodeCrypto.generateKeyPairSync("x25519");
  const jwk = privateKey.export({ format: "jwk" });
  const pub = publicKey.export({ format: "jwk" });
  if (typeof jwk.d !== "string" || typeof pub.x !== "string") {
    throw new Error("X25519 key export failed");
  }
  return { publicKey: pub.x, privateKey: jwk.d };
}

const publicKeyObject = (x: string) =>
  NodeCrypto.createPublicKey({ key: { kty: "OKP", crv: "X25519", x }, format: "jwk" });

const privateKeyObject = (pair: VaultKeyPair) =>
  NodeCrypto.createPrivateKey({
    key: { kty: "OKP", crv: "X25519", x: pair.publicKey, d: pair.privateKey },
    format: "jwk",
  });

function aeadSeal(key: Uint8Array, plaintext: Uint8Array, aad: string): Uint8Array {
  const nonce = NodeCrypto.randomBytes(NONCE_BYTES);
  const cipher = NodeCrypto.createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return new Uint8Array(Buffer.concat([nonce, body, cipher.getAuthTag()]));
}

/** Throws on a wrong key, wrong binding or tampered bytes. */
function aeadOpen(key: Uint8Array, sealed: Uint8Array, aad: string): Uint8Array {
  if (sealed.length < NONCE_BYTES + TAG_BYTES) throw new Error("ciphertext too short");
  const nonce = sealed.subarray(0, NONCE_BYTES);
  const tag = sealed.subarray(sealed.length - TAG_BYTES);
  const body = sealed.subarray(NONCE_BYTES, sealed.length - TAG_BYTES);
  const decipher = NodeCrypto.createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(tag);
  return new Uint8Array(Buffer.concat([decipher.update(body), decipher.final()]));
}

const entryAad = (entryId: string, generation: number) =>
  `fwai-vault-entry:v1:${entryId}:${generation}`;

export function encryptEntry(input: {
  readonly vaultKey: Uint8Array;
  readonly generation: number;
  readonly entryId: string;
  readonly plaintext: string;
}): string {
  return toB64(
    aeadSeal(
      input.vaultKey,
      new TextEncoder().encode(input.plaintext),
      entryAad(input.entryId, input.generation),
    ),
  );
}

export function decryptEntry(input: {
  readonly vaultKey: Uint8Array;
  readonly generation: number;
  readonly entryId: string;
  readonly ciphertext: string;
}): string {
  return new TextDecoder().decode(
    aeadOpen(input.vaultKey, fromB64(input.ciphertext), entryAad(input.entryId, input.generation)),
  );
}

const sealKey = (shared: Uint8Array, ephemeralPublic: string, recipientPublic: string) =>
  new Uint8Array(
    NodeCrypto.hkdfSync(
      "sha256",
      shared,
      Buffer.concat([fromB64(ephemeralPublic), fromB64(recipientPublic)]),
      SEAL_INFO,
      KEY_BYTES,
    ),
  );

/** The vault key sealed to one environment's public key, bound to the generation. */
export function sealVaultKey(input: {
  readonly vaultKey: Uint8Array;
  readonly generation: number;
  readonly recipientPublicKey: string;
}): string {
  const ephemeral = generateKeyPair();
  const shared = NodeCrypto.diffieHellman({
    privateKey: privateKeyObject(ephemeral),
    publicKey: publicKeyObject(input.recipientPublicKey),
  });
  const key = sealKey(shared, ephemeral.publicKey, input.recipientPublicKey);
  const sealed = aeadSeal(key, input.vaultKey, `fwai-vault-key:v1:${input.generation}`);
  return `${ephemeral.publicKey}.${toB64(sealed)}`;
}

export function openVaultKey(input: {
  readonly wrappedKey: string;
  readonly generation: number;
  readonly keyPair: VaultKeyPair;
}): Uint8Array {
  const [ephemeralPublic, sealed] = input.wrappedKey.split(".");
  if (ephemeralPublic === undefined || sealed === undefined) throw new Error("bad wrapped key");
  const shared = NodeCrypto.diffieHellman({
    privateKey: privateKeyObject(input.keyPair),
    publicKey: publicKeyObject(ephemeralPublic),
  });
  const key = sealKey(shared, ephemeralPublic, input.keyPair.publicKey);
  const vaultKey = aeadOpen(key, fromB64(sealed), `fwai-vault-key:v1:${input.generation}`);
  if (vaultKey.length !== KEY_BYTES) throw new Error("bad vault key length");
  return vaultKey;
}

/** Names a vault key without revealing it, so sync can tell a new vault from the one it knew. */
export function vaultKeyFingerprint(input: {
  readonly vaultKey: Uint8Array;
  readonly generation: number;
}): string {
  return toB64(
    NodeCrypto.createHmac("sha256", input.vaultKey)
      .update(`fwai-vault-fingerprint:v1:${input.generation}`)
      .digest()
      .subarray(0, 16),
  );
}
