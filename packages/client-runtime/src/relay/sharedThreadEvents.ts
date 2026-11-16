import {
  RelayAgentRequestsChangedEvent,
  RelaySharedThreadEvent,
  RelaySharedThreadEventsPing,
  RelaySharedThreadEventsPong,
} from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Random from "effect/Random";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Socket from "effect/socket/Socket";

import type { ManagedRelayClientError } from "./managedRelay.ts";

/** Spreads the reconnects of every client a relay deploy dropped over this window. */
const FIRST_RETRY_MAX = Duration.seconds(30);
const MAX_RETRY = Duration.minutes(10);
/** Catches up on hints the relay failed to deliver. */
export const FALLBACK_POLL_INTERVAL = Duration.minutes(10);
/** A ping unanswered by the next one marks the connection dead. */
const PING_INTERVAL = Duration.seconds(60);

/**
 * How long to wait before reconnect attempt `attempt` (0 = the first retry after a disconnect),
 * given `random` in [0, 1). The first retry is anywhere in 0–30 s; later ones back off
 * exponentially, keeping half of the window as jitter.
 */
function reconnectDelay(attempt: number, random: number): Duration.Duration {
  const firstMillis = Duration.toMillis(FIRST_RETRY_MAX);
  if (attempt <= 0) return Duration.millis(Math.floor(random * firstMillis));
  const cap = Math.min(firstMillis * 2 ** attempt, Duration.toMillis(MAX_RETRY));
  return Duration.millis(Math.floor(cap / 2 + random * (cap / 2)));
}

export class SharedThreadEventsSocketError extends Schema.TaggedError<SharedThreadEventsSocketError>()(
  "SharedThreadEventsSocketError",
  { reason: Schema.Literals(["socket", "heartbeat"]), cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return `Share push channel ${this.reason === "heartbeat" ? "stopped answering" : "failed"}`;
  }
}

/** Every hint the share push channel carries; the agent one is personal agent requests (#22). */
export type SharedThreadEventsHint =
  | RelaySharedThreadEvent["type"]
  | RelayAgentRequestsChangedEvent["type"];

export interface SharedThreadEventsHandlers {
  readonly onOpen: Effect.Effect<void>;
  readonly onHint: (type: SharedThreadEventsHint) => Effect.Effect<void>;
}

/** One connection to the relay's share push channel; ends when the connection does. */
export class SharedThreadEventsSocket extends Context.Service<
  SharedThreadEventsSocket,
  {
    readonly connect: (
      url: string,
      handlers: SharedThreadEventsHandlers,
    ) => Effect.Effect<void, SharedThreadEventsSocketError>;
  }
>()("@t3tools/client-runtime/relay/sharedThreadEvents/SharedThreadEventsSocket") {}

const decodeEvent = Schema.decodeUnknownOption(Schema.fromJsonString(RelaySharedThreadEvent));
const decodeAgentEvent = Schema.decodeUnknownOption(
  Schema.fromJsonString(RelayAgentRequestsChangedEvent),
);
const textDecoder = new TextDecoder();

export const layerWebSocket = Layer.effect(
  SharedThreadEventsSocket,
  Effect.gen(function* () {
    const webSocketConstructor = yield* Socket.WebSocketConstructor;
    const connect = Effect.fn("RelaySharedThreadEvents.connect")(function* (
      url: string,
      handlers: SharedThreadEventsHandlers,
    ) {
      const socket = yield* Socket.makeWebSocket(url, { openTimeout: "15 seconds" });
      const reader = yield* socket.reader;
      const writer = yield* socket.writer;
      yield* handlers.onOpen;
      const awaitingPong = yield* Ref.make(false);
      const heartbeat = Effect.gen(function* () {
        yield* Effect.sleep(PING_INTERVAL);
        if (yield* Ref.getAndSet(awaitingPong, true)) {
          return yield* new SharedThreadEventsSocketError({ reason: "heartbeat" });
        }
        yield* writer.write(RelaySharedThreadEventsPing);
      }).pipe(Effect.forever);
      const read = reader.pull.pipe(
        Effect.flatMap((batch) =>
          Effect.forEach(
            batch,
            (frame) => {
              const text = typeof frame === "string" ? frame : textDecoder.decode(frame);
              if (text === RelaySharedThreadEventsPong) return Ref.set(awaitingPong, false);
              const event = Option.orElse(decodeEvent(text), () => decodeAgentEvent(text));
              return Option.isSome(event) ? handlers.onHint(event.value.type) : Effect.void;
            },
            { discard: true },
          ),
        ),
        Effect.forever,
      );
      return yield* Effect.raceFirst(read, heartbeat);
    }, Effect.scoped);
    return SharedThreadEventsSocket.of({
      connect: Effect.fn("SharedThreadEventsSocket.connect")(function* (url, handlers) {
        return yield* connect(url, handlers).pipe(
          Effect.catchTags({
            SocketError: (cause) =>
              Effect.fail(new SharedThreadEventsSocketError({ reason: "socket", cause })),
          }),
          Effect.provideService(Socket.WebSocketConstructor, webSocketConstructor),
        );
      }),
    });
  }),
);

/**
 * Keeps one share push connection open while `authorize` yields a URL, running `refresh` on open
 * and `onHint` on each hint. `kicks` cancels a pending retry wait and resets the backoff (foreground, network
 * back, sign-in); `authorize` yields none while there is nothing to connect for.
 */
export const runSharedThreadEvents = Effect.fn("RelaySharedThreadEvents.run")(function* (input: {
  readonly authorize: Effect.Effect<Option.Option<string>, ManagedRelayClientError>;
  readonly refresh: Effect.Effect<void>;
  readonly onHint: SharedThreadEventsHandlers["onHint"];
  readonly kicks: Queue.Dequeue<void>;
}) {
  const socket = yield* SharedThreadEventsSocket;
  let attempt = 0;
  while (true) {
    const authorized = yield* Effect.result(input.authorize);
    const url = authorized._tag === "Success" ? authorized.success : undefined;
    if (url !== undefined && Option.isNone(url)) {
      // Signed out or offline: nothing to connect for until something changes.
      yield* Queue.take(input.kicks);
      attempt = 0;
      continue;
    }
    if (url === undefined) {
      yield* Effect.logWarning("Could not authorize the share push channel.", {
        error: authorized._tag === "Failure" ? authorized.failure : undefined,
      });
    } else {
      let opened = false;
      yield* socket
        .connect(url.value, {
          onOpen: Effect.gen(function* () {
            opened = true;
            yield* Queue.clear(input.kicks);
            yield* input.refresh;
          }),
          onHint: input.onHint,
        })
        .pipe(
          Effect.catch((error) =>
            Effect.logInfo("Share push channel closed.", { reason: error.reason }),
          ),
        );
      if (opened) attempt = 0;
    }
    const kicked = yield* Queue.take(input.kicks).pipe(
      Effect.as(true),
      Effect.timeoutOrElse({
        duration: reconnectDelay(attempt, yield* Random.next),
        orElse: () => Effect.succeed(false),
      }),
    );
    attempt = kicked ? 0 : attempt + 1;
  }
});
