// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no generateKeyPairSync.
import * as NodeCrypto from "node:crypto";
import { assert, it } from "@effect/vitest";
import { EnvironmentId, LinkGroupId, NodeId, ThreadId } from "@t3tools/contracts";
import type { RelayLinkDelivery } from "@t3tools/contracts/relay";
import { RELAY_LINK_DELIVERY_TYP, signRelayJwt } from "@t3tools/shared/relayJwt";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { CLOUD_MINT_PUBLIC_KEY, RELAY_ISSUER_SECRET } from "../cloud/config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { sha256Hex, verifyLinkDelivery } from "./linkEnvelopeRoute.ts";

const environmentId = EnvironmentId.make("env-server");
const relayIssuer = "https://relay.example.test";
const mintKeys = NodeCrypto.generateKeyPairSync("ed25519", {
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

const delivery: RelayLinkDelivery = {
  id: "cancel:task-1",
  linkId: LinkGroupId.make("link:1"),
  sender: { environmentId: EnvironmentId.make("env-laptop"), threadId: ThreadId.make("t-a") },
  target: { environmentId, threadId: ThreadId.make("t-b") },
  body: { kind: "cancel", taskId: NodeId.make("task-1"), stoppedBy: "the user" },
  actingAccountId: "alice",
  actingOrganization: null,
  relation: "same_account",
  receivedAt: "2026-11-12T00:00:00.000Z",
};

const proofFor = (
  body: string,
  claims: { readonly environmentId?: string; readonly envelopeId?: string } = {},
) =>
  Effect.gen(function* () {
    return yield* signRelayJwt({
      privateKey: mintKeys.privateKey,
      typ: RELAY_LINK_DELIVERY_TYP,
      payload: {
        iss: relayIssuer,
        aud: `t3-env:${claims.environmentId ?? environmentId}`,
        sub: environmentId,
        jti: "proof-1",
        iat: 0,
        exp: 300,
        environmentId: claims.environmentId ?? environmentId,
        envelopeId: claims.envelopeId ?? delivery.id,
        bodySha256: yield* sha256Hex(body),
      },
    });
  });

it.effect("takes only a delivery the relay signed for this exact body and environment", () =>
  Effect.gen(function* () {
    const body = JSON.stringify(delivery);
    const accepted = yield* verifyLinkDelivery({ proof: yield* proofFor(body), body });
    assert.deepEqual(Option.getOrUndefined(accepted)?.actingAccountId, "alice");

    // A sender cannot swap the acting account into a body the relay signed.
    const tampered = JSON.stringify({ ...delivery, actingAccountId: "bob" });
    assert.isTrue(
      Option.isNone(yield* verifyLinkDelivery({ proof: yield* proofFor(body), body: tampered })),
    );
    assert.isTrue(Option.isNone(yield* verifyLinkDelivery({ proof: undefined, body })));
    assert.isTrue(
      Option.isNone(
        yield* verifyLinkDelivery({
          proof: yield* proofFor(body, { environmentId: "env-other" }),
          body,
        }),
      ),
    );
    assert.isTrue(
      Option.isNone(
        yield* verifyLinkDelivery({
          proof: yield* proofFor(body, { envelopeId: "result:task-1" }),
          body,
        }),
      ),
    );
  }).pipe(Effect.provide(layer)),
);
