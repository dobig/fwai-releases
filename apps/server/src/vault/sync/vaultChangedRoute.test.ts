// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no generateKeyPairSync.
import * as NodeCrypto from "node:crypto";
import { assert, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import { RELAY_LINK_DELIVERY_TYP, signRelayJwt } from "@t3tools/shared/relayJwt";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import { CLOUD_MINT_PUBLIC_KEY, RELAY_ISSUER_SECRET } from "../../cloud/config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import { sha256Hex } from "../../link/linkEnvelopeRoute.ts";
import { verifyVaultChanged } from "./vaultChangedRoute.ts";

const environmentId = EnvironmentId.make("env-server");
const relayIssuer = "https://relay.example.test";
const mintKeys = NodeCrypto.generateKeyPairSync("ed25519", {
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});
const otherKeys = NodeCrypto.generateKeyPairSync("ed25519", {
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});
const secrets: ReadonlyMap<string, string> = new Map([
  [CLOUD_MINT_PUBLIC_KEY, mintKeys.publicKey],
  [RELAY_ISSUER_SECRET, relayIssuer],
]);

const layer = Layer.mergeAll(
  Layer.mock(ServerSecretStore.ServerSecretStore)({
    get: (name) =>
      Effect.succeed(
        Option.map(Option.fromUndefinedOr(secrets.get(name)), (value) =>
          new TextEncoder().encode(value),
        ),
      ),
  }),
  Layer.mock(ServerEnvironment.ServerEnvironment)({
    getEnvironmentId: Effect.succeed(environmentId),
  }),
);

const body = JSON.stringify({ targetEnvironmentId: environmentId, cursor: "42" });

const proofFor = (
  signed: string,
  claims: {
    readonly environmentId?: string;
    readonly envelopeId?: string;
    readonly privateKey?: string;
  } = {},
) =>
  Effect.gen(function* () {
    return yield* signRelayJwt({
      privateKey: claims.privateKey ?? mintKeys.privateKey,
      typ: RELAY_LINK_DELIVERY_TYP,
      payload: {
        iss: relayIssuer,
        aud: `t3-env:${claims.environmentId ?? environmentId}`,
        sub: environmentId,
        jti: "proof-1",
        iat: 0,
        exp: 300,
        environmentId: claims.environmentId ?? environmentId,
        envelopeId: claims.envelopeId ?? "vault:42",
        bodySha256: yield* sha256Hex(signed),
      },
    });
  });

it.effect("takes only a vault.changed hint the relay signed for this body and environment", () =>
  Effect.gen(function* () {
    const accepted = yield* verifyVaultChanged({ proof: yield* proofFor(body), body });
    assert.equal(Option.getOrUndefined(accepted)?.cursor, "42");

    const refused = [
      { proof: undefined, body },
      { proof: yield* proofFor(body, { privateKey: otherKeys.privateKey }), body },
      { proof: yield* proofFor(body), body: body.replace("42", "43") },
      { proof: yield* proofFor(body, { environmentId: "env-other" }), body },
      { proof: yield* proofFor(body, { envelopeId: "vault:41" }), body },
    ];
    for (const input of refused) {
      assert.isTrue(Option.isNone(yield* verifyVaultChanged(input)));
    }
    const forOther = JSON.stringify({ targetEnvironmentId: "env-other", cursor: "42" });
    assert.isTrue(
      Option.isNone(
        yield* verifyVaultChanged({ proof: yield* proofFor(forOther), body: forOther }),
      ),
    );
  }).pipe(Effect.provide(layer)),
);
