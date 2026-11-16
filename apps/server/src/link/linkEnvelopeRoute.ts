// fwai: the relay forwards linked-thread envelopes here (#21 phase 2). Only a body the relay
// signed for this environment counts: the proof names the envelope and the body's hash.
import {
  RELAY_LINK_ENVELOPE_ROUTE,
  RelayLinkDelivery,
  RelayLinkDeliveryProofPayload,
  type RelayLinkReceipt,
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
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { CLOUD_MINT_PUBLIC_KEY, RELAY_ISSUER_SECRET, RELAY_URL_SECRET } from "../cloud/config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as LinkService from "./LinkService.ts";

const MAX_ENVELOPE_BYTES = 128 * 1024;
/** The relay signs right before it posts; allow for clock skew. */
const MAX_PROOF_AGE_SECONDS = 10 * 60;

const decodeProof = Schema.decodeUnknownOption(RelayLinkDeliveryProofPayload);
const decodeDelivery = Schema.decodeUnknownOption(Schema.fromJsonString(RelayLinkDelivery));

const receipt = (status: number, body: RelayLinkReceipt) =>
  HttpServerResponse.jsonUnsafe(body, { status });

export const sha256Hex = (text: string) =>
  Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))).pipe(
    Effect.map((digest) =>
      Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""),
    ),
  );

const readSecret = (secrets: ServerSecretStore.ServerSecretStore["Service"], name: string) =>
  secrets.get(name).pipe(
    Effect.map(Option.map((bytes) => new TextDecoder().decode(bytes))),
    Effect.orElseSucceed(() => Option.none<string>()),
  );

/** The delivery, when the proof is the relay's, names this environment, and matches the body. */
export const verifyLinkDelivery = Effect.fn("link.verifyDelivery")(function* (input: {
  readonly proof: string | undefined;
  readonly body: string;
}) {
  if (input.proof === undefined) return Option.none<RelayLinkDelivery>();
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const publicKey = yield* readSecret(secrets, CLOUD_MINT_PUBLIC_KEY);
  const issuer = Option.orElse(yield* readSecret(secrets, RELAY_ISSUER_SECRET), () =>
    Option.none<string>(),
  );
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
    delivery.value.id !== payload.value.envelopeId ||
    delivery.value.target.environmentId !== environmentId
  ) {
    return Option.none();
  }
  return delivery;
});

const handlePost = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const body = yield* request.text.pipe(
    Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(MAX_ENVELOPE_BYTES)),
    Effect.option,
  );
  if (Option.isNone(body)) {
    return receipt(413, { accepted: false, code: "invalid", message: "Envelope too large." });
  }
  const delivery = yield* verifyLinkDelivery({
    proof: request.headers[RELAY_LINK_DELIVERY_HEADER],
    body: body.value,
  }).pipe(Effect.orElseSucceed(() => Option.none<RelayLinkDelivery>()));
  if (Option.isNone(delivery)) {
    return receipt(401, { accepted: false, code: "not_authorized" });
  }
  const links = yield* LinkService.LinkService;
  return receipt(200, yield* links.receive(delivery.value));
});

export const layer = Layer.mergeAll(
  HttpRouter.add("POST", RELAY_LINK_ENVELOPE_ROUTE, handlePost),
  // The relay probes this to tell whether the environment is up.
  HttpRouter.add("GET", RELAY_LINK_ENVELOPE_ROUTE, HttpServerResponse.empty({ status: 204 })),
);
