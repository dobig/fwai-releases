// @effect-diagnostics nodeBuiltinImport:off - verifies Ed25519 signatures the service produced.
import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import type { EnvironmentId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { getOrCreateEnvironmentKeyPairFromSecretStore } from "../cloud/environmentKeys.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as FwaiAttestation from "./FwaiAttestation.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

const decodeJwt = (token: string) => {
  const [header, payload, signature] = token.split(".");
  return {
    header: JSON.parse(Buffer.from(header!, "base64url").toString()),
    payload: JSON.parse(Buffer.from(payload!, "base64url").toString()),
    verifiesWith: (publicKey: string) =>
      NodeCrypto.verify(
        null,
        Buffer.from(`${header}.${payload}`),
        NodeCrypto.createPublicKey({
          key: { kty: "OKP", crv: "Ed25519", x: publicKey },
          format: "jwk",
        }),
        Buffer.from(signature!, "base64url"),
      ),
  };
};

const layer = Layer.provideMerge(
  FwaiAttestation.layer,
  Layer.mergeAll(
    Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed("env-1" as EnvironmentId),
    }),
    ServerSecretStore.layer,
  ),
).pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "fwai-attestation-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.provide(layer));

const service = Effect.service(FwaiAttestation.FwaiAttestation);

/** Registers whatever key the service offers, as a client would after a 200. */
const registerAt = (expiresAtMs: number) =>
  Effect.gen(function* () {
    const attestation = yield* service;
    const registration = yield* attestation.registration;
    assert.isNotNull(registration);
    yield* attestation.report({
      publicKey: registration!.publicKey,
      outcome: { status: "registered", expiresAt: iso(expiresAtMs) },
    });
    return registration!.publicKey;
  });

it.effect("signs only after the gateway confirms the key, with the agreed JWT shape", () =>
  provide(
    Effect.gen(function* () {
      const attestation = yield* service;
      const registration = yield* attestation.registration;
      assert.deepEqual(Object.keys(registration ?? {}).toSorted(), [
        "environmentId",
        "name",
        "publicKey",
      ]);
      assert.equal(registration?.environmentId, "env-1");
      assert.equal(Buffer.from(registration!.publicKey, "base64url").length, 32);
      // Nothing signs before registration succeeds (a 404 gateway never reports).
      assert.isTrue(Option.isNone(yield* attestation.sign({})));

      yield* attestation.report({
        publicKey: registration!.publicKey,
        outcome: { status: "registered", expiresAt: iso(30 * DAY_MS) },
      });
      const signed = yield* attestation.sign({ sid: "session-1", thr: "thread-1" });
      assert.isTrue(Option.isSome(signed));
      const jwt = decodeJwt(Option.getOrThrow(signed).token);
      assert.deepEqual(jwt.header, {
        alg: "EdDSA",
        typ: "fwai-att+jwt",
        kid: FwaiAttestation.keyId(registration!.publicKey),
      });
      assert.equal(jwt.payload.v, 1);
      assert.equal(jwt.payload.env, "env-1");
      assert.match(jwt.payload.app, /^fwai\//);
      assert.equal(jwt.payload.exp - jwt.payload.iat, 4 * 60 * 60);
      assert.equal(jwt.payload.sid, "session-1");
      assert.equal(jwt.payload.thr, "thread-1");
      assert.isTrue(jwt.verifiesWith(registration!.publicKey));
      assert.equal(Option.getOrThrow(signed).expiresAtMs, jwt.payload.exp * 1000);
    }),
  ),
);

it.effect(
  "rotates seven days before expiry and switches keys only once the new one is registered",
  () =>
    provide(
      Effect.gen(function* () {
        const attestation = yield* service;
        const first = yield* registerAt(30 * DAY_MS);
        // Well before rotation, connecting clients re-register the same key.
        assert.equal((yield* attestation.registration)?.publicKey, first);

        yield* TestClock.adjust(24 * DAY_MS);
        const next = (yield* attestation.registration)?.publicKey;
        assert.isDefined(next);
        assert.notEqual(next, first);
        // Until the gateway confirms the new key, the old one keeps signing.
        const beforeSwitch = decodeJwt(Option.getOrThrow(yield* attestation.sign({})).token);
        assert.equal(beforeSwitch.header.kid, FwaiAttestation.keyId(first));
        // The same pending key is offered again until it registers.
        assert.equal((yield* attestation.registration)?.publicKey, next);

        yield* attestation.report({
          publicKey: next!,
          outcome: { status: "registered", expiresAt: iso(54 * DAY_MS) },
        });
        const afterSwitch = decodeJwt(Option.getOrThrow(yield* attestation.sign({})).token);
        assert.equal(afterSwitch.header.kid, FwaiAttestation.keyId(next!));
        assert.isTrue(afterSwitch.verifiesWith(next!));
      }),
    ),
);

it.effect("stops signing when the key expires without a successful rotation", () =>
  provide(
    Effect.gen(function* () {
      const attestation = yield* service;
      yield* registerAt(30 * DAY_MS);
      yield* TestClock.adjust(30 * DAY_MS - 60 * 60 * 1000);
      const last = decodeJwt(Option.getOrThrow(yield* attestation.sign({})).token);
      // A header never outlives its key.
      assert.equal(last.payload.exp, (30 * DAY_MS) / 1000);
      yield* TestClock.adjust(60 * 60 * 1000);
      assert.isTrue(Option.isNone(yield* attestation.sign({})));
    }),
  ),
);

it.effect("replaces a revoked key", () =>
  provide(
    Effect.gen(function* () {
      const attestation = yield* service;
      const revoked = yield* registerAt(30 * DAY_MS);
      yield* attestation.report({ publicKey: revoked, outcome: { status: "key-rejected" } });
      assert.isTrue(Option.isNone(yield* attestation.sign({})));
      const replacement = (yield* attestation.registration)?.publicKey;
      assert.isDefined(replacement);
      assert.notEqual(replacement, revoked);
    }),
  ),
);

it.effect("drops a corrupt private key, stops signing and offers a new key", () =>
  provide(
    Effect.gen(function* () {
      const attestation = yield* service;
      const broken = yield* registerAt(30 * DAY_MS);
      const secrets = yield* ServerSecretStore.ServerSecretStore;
      const stored = JSON.parse(
        new TextDecoder().decode(Option.getOrThrow(yield* secrets.get("fwai-attestation-keys"))),
      );
      // A private key that no longer matches the recorded public key.
      stored.active.privateKey = FwaiAttestation.generateKeyPair().privateKey;
      yield* secrets.set("fwai-attestation-keys", new TextEncoder().encode(JSON.stringify(stored)));
      assert.isTrue(Option.isNone(yield* attestation.sign({})));
      const replacement = (yield* attestation.registration)?.publicKey;
      assert.isDefined(replacement);
      assert.notEqual(replacement, broken);
    }),
  ),
);

it.effect("keeps its key apart from the CloudLink key", () =>
  provide(
    Effect.gen(function* () {
      const secrets = yield* ServerSecretStore.ServerSecretStore;
      const cloudLink = yield* getOrCreateEnvironmentKeyPairFromSecretStore(secrets);
      const attestation = yield* registerAt(30 * DAY_MS);
      const cloudLinkRaw = NodeCrypto.createPublicKey(cloudLink.publicKey).export({
        format: "jwk",
      }).x;
      assert.notEqual(attestation, cloudLinkRaw);
      // Rotating the attestation key leaves the CloudLink key alone.
      yield* (yield* service).report({
        publicKey: attestation,
        outcome: { status: "key-rejected" },
      });
      assert.deepEqual(yield* getOrCreateEnvironmentKeyPairFromSecretStore(secrets), cloudLink);
    }),
  ),
);
