// fwai: the relay posts a `vault.changed` hint here after another environment writes the vault.
// Only a body the relay signed for this environment counts, as for link envelopes; the proof
// names `vault:<cursor>` and the body's hash.
import {
  RELAY_VAULT_CHANGED_ROUTE,
  RelayLinkDeliveryProofPayload,
  RelayVaultChangedDelivery,
} from "@t3tools/contracts/relay";
import {
  normalizeRelayIssuer,
  RELAY_LINK_DELIVERY_HEADER,
  RELAY_LINK_DELIVERY_TYP,
  verifyRelayJwt,
} from "@t3tools/shared/relayJwt";
import * as ByteSize from "effect/ByteSize";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import {
  CLOUD_MINT_PUBLIC_KEY,
  RELAY_ISSUER_SECRET,
  RELAY_URL_SECRET,
} from "../../cloud/config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import { sha256Hex } from "../../link/linkEnvelopeRoute.ts";
import * as VaultSyncTriggers from "./VaultSyncTriggers.ts";

const MAX_BODY_BYTES = 4 * 1024;
const MAX_PROOF_AGE_SECONDS = 10 * 60;

const decodeProof = Schema.decodeUnknownOption(RelayLinkDeliveryProofPayload);
const decodeDelivery = Schema.decodeUnknownOption(Schema.fromJsonString(RelayVaultChangedDelivery));

const readSecret = (secrets: ServerSecretStore.ServerSecretStore["Service"], name: string) =>
  secrets.get(name).pipe(
    Effect.map(Option.map((bytes) => new TextDecoder().decode(bytes))),
    Effect.orElseSucceed(() => Option.none<string>()),
  );

export const verifyVaultChanged = Effect.fn("vault.verifyChanged")(function* (input: {
  readonly proof: string | undefined;
  readonly body: string;
}) {
  if (input.proof === undefined) return Option.none<RelayVaultChangedDelivery>();
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const publicKey = yield* readSecret(secrets, CLOUD_MINT_PUBLIC_KEY);
  const issuer = yield* readSecret(secrets, RELAY_ISSUER_SECRET);
  const relayIssuer = Option.isSome(issuer) ? issuer : yield* readSecret(secrets, RELAY_URL_SECRET);
  if (Option.isNone(publicKey) || Option.isNone(relayIssuer)) return Option.none();
  const environmentId = yield* environment.getEnvironmentId;
  const payload = yield* verifyRelayJwt({
    publicKey: publicKey.value,
    token: input.proof,
    typ: RELAY_LINK_DELIVERY_TYP,
    issuer: normalizeRelayIssuer(relayIssuer.value),
    audience: `t3-env:${environmentId}`,
    nowEpochSeconds: Math.floor((yield* Clock.currentTimeMillis) / 1_000),
    maxTokenAge: MAX_PROOF_AGE_SECONDS,
  }).pipe(Effect.map(decodeProof), Effect.orElseSucceed(Option.none));
  if (
    Option.isNone(payload) ||
    payload.value.environmentId !== environmentId ||
    payload.value.bodySha256 !== (yield* sha256Hex(input.body))
  ) {
    return Option.none();
  }
  const delivery = decodeDelivery(input.body);
  if (
    Option.isNone(delivery) ||
    payload.value.envelopeId !== `vault:${delivery.value.cursor}` ||
    delivery.value.targetEnvironmentId !== environmentId
  ) {
    return Option.none();
  }
  return delivery;
});

const handlePost = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const body = yield* request.text.pipe(
    Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(MAX_BODY_BYTES)),
    Effect.option,
  );
  if (Option.isNone(body)) return HttpServerResponse.empty({ status: 413 });
  const delivery = yield* verifyVaultChanged({
    proof: request.headers[RELAY_LINK_DELIVERY_HEADER],
    body: body.value,
  }).pipe(Effect.orElseSucceed(() => Option.none<RelayVaultChangedDelivery>()));
  if (Option.isNone(delivery)) return HttpServerResponse.empty({ status: 401 });
  yield* (yield* VaultSyncTriggers.VaultSyncTriggers).changed();
  return HttpServerResponse.empty({ status: 202 });
});

export const layer = HttpRouter.add("POST", RELAY_VAULT_CHANGED_ROUTE, handlePost);
