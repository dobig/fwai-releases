import type {
  RelayLinkEnvelope,
  RelayLinkPresenceRequest,
  RelayLinkPresenceResponse,
  RelayLinkSendResponse,
} from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { readRelayConnection } from "../cloud/config.ts";
import { makeRelayEnvironmentClient } from "../relay/relayEnvironmentClient.ts";

/**
 * This environment's side of the relay's linked-thread transport (#21 phase 2). It speaks with
 * the environment credential it already holds; no account token is stored here. Every call
 * yields null while fwai Connect is not linked or the relay cannot be reached.
 */
export class LinkRelay extends Context.Service<
  LinkRelay,
  {
    readonly send: (envelope: RelayLinkEnvelope) => Effect.Effect<RelayLinkSendResponse | null>;
    readonly presence: (
      request: RelayLinkPresenceRequest,
    ) => Effect.Effect<RelayLinkPresenceResponse | null>;
  }
>()("t3/link/LinkRelay") {}

export const layer = Layer.effect(
  LinkRelay,
  Effect.gen(function* () {
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const client = readRelayConnection.pipe(
      Effect.flatMap((connection) =>
        connection === null ? Effect.succeed(null) : makeRelayEnvironmentClient(connection),
      ),
      Effect.provideService(ServerSecretStore.ServerSecretStore, secrets),
    );
    const call = <A, E>(
      operation: string,
      run: (relay: NonNullable<Effect.Success<typeof client>>) => Effect.Effect<A, E>,
    ): Effect.Effect<A | null> =>
      client.pipe(
        Effect.flatMap((relay) => (relay === null ? Effect.succeed(null) : run(relay))),
        Effect.timeout("15 seconds"),
        Effect.catchCause((cause) =>
          Effect.logWarning("fwai Connect did not take a linked-thread request", {
            operation,
            cause,
          }).pipe(Effect.as(null)),
        ),
      );
    return LinkRelay.of({
      send: Effect.fn("LinkRelay.send")((envelope) =>
        call("send", (relay) => relay.server.sendLinkEnvelope({ payload: envelope })),
      ),
      presence: Effect.fn("LinkRelay.presence")((request) =>
        call("presence", (relay) => relay.server.linkPresence({ payload: request })),
      ),
    });
  }),
);
