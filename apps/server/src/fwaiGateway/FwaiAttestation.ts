// @effect-diagnostics nodeBuiltinImport:off - Effect's Crypto has no Ed25519 keys or signatures.
import * as NodeCrypto from "node:crypto";

import type { FwaiAttestationRegistration, FwaiAttestationReport } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import packageJson from "../../package.json" with { type: "json" };
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";

/**
 * The environment's own key for the X-FWAI-Attestation header (llm_gateway#760). Kept apart from
 * the CloudLink key so it can be rotated and revoked alone and cannot impersonate the environment.
 */
const SECRET = "fwai-attestation-keys";
const ROTATE_BEFORE_MS = 7 * 24 * 60 * 60 * 1000;
const JWT_LIFETIME_SECONDS = 4 * 60 * 60;
const NAME_MAX_LENGTH = 100;
const SELF_CHECK_MESSAGE = Buffer.from("fwai-attestation-self-check");

const KeyPair = Schema.Struct({
  /** PKCS#8 DER, base64url. */
  privateKey: Schema.String,
  /** Raw 32-byte Ed25519 key, base64url without padding. */
  publicKey: Schema.String,
});
type KeyPair = typeof KeyPair.Type;

const Keys = Schema.Struct({
  /** Registered with the gateway; the only key that signs. */
  active: Schema.NullOr(Schema.Struct({ ...KeyPair.fields, expiresAtMs: Schema.Number })),
  /** Generated, not yet registered: the first key or the next one during rotation. */
  pending: Schema.NullOr(KeyPair),
});
type Keys = typeof Keys.Type;
const decodeKeys = Schema.decodeUnknownOption(Schema.fromJsonString(Keys));
const encodeKeys = Schema.encodeSync(Schema.fromJsonString(Keys));
const NO_KEYS: Keys = { active: null, pending: null };

const base64Url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

export const generateKeyPair = (): KeyPair => {
  const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" });
  return {
    privateKey: base64Url(privateKey.export({ format: "der", type: "pkcs8" })),
    publicKey: String(jwk.x),
  };
};

/** `base64url(SHA-256(raw public key))`, as the gateway derives it. */
export const keyId = (publicKey: string) =>
  base64Url(NodeCrypto.createHash("sha256").update(Buffer.from(publicKey, "base64url")).digest());

const privateKeyOf = (key: KeyPair) =>
  NodeCrypto.createPrivateKey({
    key: Buffer.from(key.privateKey, "base64url"),
    format: "der",
    type: "pkcs8",
  });

/** The private key signs and the stored public key verifies: catches a corrupt or swapped key. */
const keyPairWorks = (key: KeyPair): boolean => {
  try {
    const signature = NodeCrypto.sign(null, SELF_CHECK_MESSAGE, privateKeyOf(key));
    const publicKey = NodeCrypto.createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: key.publicKey },
      format: "jwk",
    });
    return NodeCrypto.verify(null, SELF_CHECK_MESSAGE, publicKey, signature);
  } catch {
    return false;
  }
};

const encodeSegment = (value: unknown) => base64Url(Buffer.from(JSON.stringify(value)));

export interface FwaiAttestationClaims {
  /** The CLI session id (Claude's session id, Codex's thread id) when known before launch. */
  readonly sid?: string;
  /** The fwai thread id. */
  readonly thr?: string;
}

export interface FwaiAttestationToken {
  readonly token: string;
  readonly expiresAtMs: number;
}

export class FwaiAttestation extends Context.Service<
  FwaiAttestation,
  {
    /** The key a signed-in client should register now, or null when nothing can be registered. */
    readonly registration: Effect.Effect<FwaiAttestationRegistration | null>;
    /** Records what the gateway answered; a newly registered key starts signing from here. */
    readonly report: (report: FwaiAttestationReport) => Effect.Effect<void>;
    /** A fresh header value, or none while no registered, unexpired, working key exists. */
    readonly sign: (
      claims: FwaiAttestationClaims,
    ) => Effect.Effect<Option.Option<FwaiAttestationToken>>;
  }
>()("t3/fwaiGateway/FwaiAttestation") {}

const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const lock = yield* Semaphore.make(1);

  const persist = (keys: Keys) =>
    secrets
      .set(SECRET, new TextEncoder().encode(encodeKeys(keys)))
      .pipe(
        Effect.catch((cause) => Effect.logWarning("fwai attestation keys not saved", { cause })),
      );

  // A key that fails the self-check is dropped; registration then generates a new one.
  const load = Effect.gen(function* () {
    const stored = yield* secrets.get(SECRET).pipe(
      Effect.map(Option.flatMap((bytes) => decodeKeys(new TextDecoder().decode(bytes)))),
      Effect.orElseSucceed(() => Option.none<Keys>()),
    );
    const keys = Option.getOrElse(stored, () => NO_KEYS);
    const checked: Keys = {
      active: keys.active !== null && keyPairWorks(keys.active) ? keys.active : null,
      pending: keys.pending !== null && keyPairWorks(keys.pending) ? keys.pending : null,
    };
    if (checked.active !== keys.active || checked.pending !== keys.pending) {
      yield* Effect.logWarning("fwai attestation key failed its self-check; replacing it");
      yield* persist(checked);
    }
    return checked;
  });

  yield* lock.withPermits(1)(load);

  const registration = lock
    .withPermits(1)(
      Effect.gen(function* () {
        const keys = yield* load;
        const now = yield* Clock.currentTimeMillis;
        let candidate: KeyPair;
        if (keys.pending !== null) {
          candidate = keys.pending;
        } else if (keys.active !== null && keys.active.expiresAtMs - now > ROTATE_BEFORE_MS) {
          // Registering the active key again is idempotent and recovers a gateway that lost it.
          candidate = keys.active;
        } else {
          candidate = generateKeyPair();
          yield* persist({ ...keys, pending: candidate });
        }
        return {
          environmentId: yield* identity.getEnvironmentId,
          publicKey: candidate.publicKey,
          name: (yield* HostProcess.Hostname).slice(0, NAME_MAX_LENGTH),
        } satisfies FwaiAttestationRegistration;
      }),
    )
    .pipe(Effect.withSpan("FwaiAttestation.registration"));

  const report = (input: FwaiAttestationReport) =>
    lock
      .withPermits(1)(
        Effect.gen(function* () {
          const keys = yield* load;
          const { outcome, publicKey } = input;
          let next: Keys = keys;
          if (outcome.status === "registered") {
            const expiresAtMs = Date.parse(outcome.expiresAt);
            if (Number.isNaN(expiresAtMs)) return;
            if (keys.pending?.publicKey === publicKey) {
              // Switch only now that the gateway knows the new key; the old private key goes.
              next = { active: { ...keys.pending, expiresAtMs }, pending: null };
            } else if (keys.active?.publicKey === publicKey) {
              next = { ...keys, active: { ...keys.active, expiresAtMs } };
            }
          } else {
            next = {
              active: keys.active?.publicKey === publicKey ? null : keys.active,
              pending: keys.pending?.publicKey === publicKey ? null : keys.pending,
            };
          }
          if (next !== keys) yield* persist(next);
        }),
      )
      .pipe(Effect.withSpan("FwaiAttestation.report"));

  const sign = (claims: FwaiAttestationClaims) =>
    lock
      .withPermits(1)(
        Effect.gen(function* () {
          const { active } = yield* load;
          if (active === null) return Option.none<FwaiAttestationToken>();
          const iat = Math.floor((yield* Clock.currentTimeMillis) / 1000);
          const exp = Math.min(iat + JWT_LIFETIME_SECONDS, Math.floor(active.expiresAtMs / 1000));
          if (exp <= iat) return Option.none<FwaiAttestationToken>();
          const signingInput = `${encodeSegment({
            alg: "EdDSA",
            typ: "fwai-att+jwt",
            kid: keyId(active.publicKey),
          })}.${encodeSegment({
            v: 1,
            env: yield* identity.getEnvironmentId,
            app: `fwai/${packageJson.version}`,
            iat,
            exp,
            ...(claims.sid === undefined ? {} : { sid: claims.sid }),
            ...(claims.thr === undefined ? {} : { thr: claims.thr }),
          })}`;
          const signature = NodeCrypto.sign(null, Buffer.from(signingInput), privateKeyOf(active));
          return Option.some({
            token: `${signingInput}.${base64Url(signature)}`,
            expiresAtMs: exp * 1000,
          });
        }),
      )
      .pipe(Effect.withSpan("FwaiAttestation.sign"));

  return FwaiAttestation.of({ registration, report, sign });
});

export const layer = Layer.effect(FwaiAttestation, make);
