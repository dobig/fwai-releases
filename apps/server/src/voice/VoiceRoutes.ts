// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalFetch:off abortControllerInEffect:off preferSchemaOverJson:off - drives the plain-TS voice core.
/**
 * Voice control in the server: a page at /voice, its socket at /voice/ws (cookie or
 * wsTicket), and the loops that watch threads and speak. Doubao goes through the relay,
 * which holds the keys; threads are watched only within a day of a voice client.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import {
  DEFAULT_VOICE_CONFIG,
  doubaoAccess,
  type VoiceConfig,
  type VoiceRelay,
} from "@t3tools/shared/voice/config";
import { EndOfSpeech } from "@t3tools/shared/voice/endOfSpeech";
import { VoiceHub } from "@t3tools/shared/voice/hub";
import { DoubaoLlm } from "@t3tools/shared/voice/llm";
import { type Logger, Sessions } from "@t3tools/shared/voice/sessions";
import { Speaker } from "@t3tools/shared/voice/speaker";

import { authenticateMediaRequest } from "../auth/http.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { readRelayConnection } from "../cloud/config.ts";
import * as ServerConfig from "../config.ts";
import { loadVoiceConfig, RELAY_VOICE_PATH } from "./config.ts";
import { transcribe } from "./doubaoAsr.ts";
import { synthesize, TtsCache } from "./doubaoTts.ts";
import { loadSpeechDetector, voiceAssetsDir } from "./silero.ts";
import { VoiceStore } from "./store.ts";
import * as VoiceT3Adapter from "./VoiceT3Adapter.ts";

const POLL_MILLIS = 2_000;
/** How long after the last voice client threads are still watched. */
const ACTIVE_AFTER_CLIENT_MILLIS = 24 * 60 * 60 * 1000;
/** How often the relay is asked again whether it offers voice. */
const RELAY_PROBE_MILLIS = 5 * 60 * 1000;
const LAST_CLIENT_TOUCH_MILLIS = 10 * 60 * 1000;

/** The relay's environment voice routes, with this environment's credential. */
function environmentRelay(url: string, credential: string): VoiceRelay {
  return {
    base: `${url.replace(/\/+$/, "")}${RELAY_VOICE_PATH}`,
    authorize: async () => ({ Authorization: `Bearer ${credential}` }),
  };
}

/** Does the relay offer voice to this environment? `null` when it could not be asked. */
async function probeRelay(relay: VoiceRelay): Promise<boolean | null> {
  const access = doubaoAccess({ ...DEFAULT_VOICE_CONFIG, relay });
  if (access?.kind !== "relay") return false;
  try {
    const response = await fetch(access.base, {
      headers: await access.authorize("GET", access.base),
      signal: AbortSignal.timeout(10_000),
    });
    return response.status === 204;
  } catch {
    return null;
  }
}

function readPage(logger: Logger): string {
  try {
    return NodeFS.readFileSync(NodePath.join(voiceAssetsDir(), "voice.html"), "utf8");
  } catch (error) {
    logger.warn("voice page missing; voice control stays off", error);
    return "<p>Voice assets are missing from this build.</p>";
  }
}

const makeVoice = Effect.gen(function* () {
  const serverConfig = yield* ServerConfig.ServerConfig;
  const t3 = yield* VoiceT3Adapter.make;
  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);
  const runPromise = Effect.runPromiseWith(context);
  const logger: Logger = {
    info: (message) => void runFork(Effect.logInfo(message)),
    warn: (message, error) => void runFork(Effect.logWarning(message, { cause: error })),
  };
  const dir = NodePath.join(serverConfig.stateDir, "voice");
  NodeFS.mkdirSync(dir, { recursive: true });
  const loaded = loadVoiceConfig(NodePath.join(dir, "config.json"), process.env);
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const readRelay = readRelayConnection.pipe(
    Effect.provideService(ServerSecretStore.ServerSecretStore, secrets),
  );

  // The relay link can appear, change or go away while the server runs.
  let relay: VoiceRelay | null = null;
  let relayKey: string | null = null;
  let relayOffered = false;
  let probedKey: string | null = null;
  let probedAt = 0;
  let refreshing: Promise<void> | null = null;
  const refreshRelay = (): Promise<void> =>
    (refreshing ??= (async () => {
      const connection = await runPromise(readRelay).catch(() => null);
      const key = connection ? `${connection.url}\n${connection.environmentCredential}` : null;
      const next = connection
        ? environmentRelay(connection.url, connection.environmentCredential)
        : null;
      if (key !== relayKey) {
        relay = next;
        relayKey = key;
      }
      if (loaded.doubaoApiKey) return; // calls Doubao directly
      if (key === null) {
        relayOffered = false;
      } else if (key !== probedKey || Date.now() - probedAt > RELAY_PROBE_MILLIS) {
        const offered = await probeRelay(next!);
        if (offered !== null) {
          relayOffered = offered;
          probedKey = key;
          probedAt = Date.now();
        }
      }
    })().finally(() => (refreshing = null)));
  const config = (): VoiceConfig => ({ ...loaded, relay: relayOffered ? relay : null });

  // When a voice client was last connected; persisted so a restart keeps watching.
  const lastClientPath = NodePath.join(dir, "last-client");
  let lastClientAt = (() => {
    try {
      return NodeFS.statSync(lastClientPath).mtimeMs;
    } catch {
      return 0;
    }
  })();
  let lastClientTouched = 0;
  const touchLastClient = () => {
    lastClientAt = Date.now();
    if (lastClientAt - lastClientTouched < LAST_CLIENT_TOUCH_MILLIS) return;
    lastClientTouched = lastClientAt;
    try {
      NodeFS.writeFileSync(lastClientPath, "");
      const now = new Date();
      NodeFS.utimesSync(lastClientPath, now, now);
    } catch (error) {
      logger.warn("voice: could not record the last client", error);
    }
  };
  const page = readPage(logger);
  // A page left open across a restart only reconnects; the version tells it to reload.
  const version = NodeCrypto.createHash("sha256").update(page).digest("hex").slice(0, 12);

  const store = new VoiceStore(NodePath.join(dir, "voice.sqlite"));
  const cache = new TtsCache(NodePath.join(dir, "tts-cache"), synthesize);
  let hub: VoiceHub | null = null;
  const speaker = new Speaker(
    config,
    (c, text) => cache.speak(c, text),
    {
      play: (chunks, rate) => hub!.play(chunks, rate),
      stop: () => hub!.stop(),
      cue: (name) => hub!.cue(name),
    },
    (text, followup) => hub!.announce(text, followup),
  );
  const sessions = new Sessions({ config, t3, llm: new DoubaoLlm(config), speaker, store, logger });
  hub = new VoiceHub({
    config,
    sessions,
    speaker,
    store,
    transcribe,
    endOfSpeech: async (startTimeout) =>
      new EndOfSpeech(
        await loadSpeechDetector((error) =>
          logger.warn("voice activity model failed to load", error),
        ),
        config().silenceSeconds,
        startTimeout,
      ),
    version,
    logger,
  });

  const built = page.includes("__PAGE_VERSION__");
  const available = () => built && doubaoAccess(config()) !== null;
  if (built) {
    const abort = new AbortController();
    yield* Effect.addFinalizer(() => Effect.sync(() => abort.abort()));
    void speaker.run(abort.signal, (error) => logger.warn("voice playback failed", error));
    const loop = async () => {
      let warmed = false;
      let watching = false;
      while (!abort.signal.aborted) {
        try {
          if (hub!.size > 0) touchLastClient();
          const recent = Date.now() - lastClientAt < ACTIVE_AFTER_CLIENT_MILLIS;
          // Environments without voice clients never ask the relay.
          if (recent) await refreshRelay();
          const active = recent && available();
          if (active && !watching) {
            // What finished while nobody listened is not news.
            sessions.initialized = false;
            logger.info("voice: watching threads");
          } else if (!active && watching) {
            logger.info("voice: no voice client for a day; not watching threads");
          }
          watching = active;
          if (active) {
            await sessions.poll();
            hub!.publishState();
            if (!warmed) {
              warmed = true;
              void cache.prewarm(config(), sessions.commonLines());
            }
          }
        } catch (error) {
          logger.warn("voice: reading threads failed", error);
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_MILLIS));
      }
    };
    void loop();
  }
  yield* Effect.addFinalizer(() => Effect.sync(() => store.close()));
  return {
    hub,
    page: page.replace("__PAGE_VERSION__", version),
    available,
    /** A client connected: watch threads, and make sure the relay was asked. */
    clientConnected: async () => {
      touchLastClient();
      await refreshRelay();
    },
  };
});

type Voice = Effect.Success<typeof makeVoice>;

// Request middleware owns tracing, including the long-lived socket.
const socketHandler = Effect.fnUntraced(function* (voice: Voice) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (request.headers.upgrade?.toLowerCase() !== "websocket")
    return HttpServerResponse.text("Not Found", { status: 404 });
  yield* authenticateMediaRequest(AuthOrchestrationOperateScope);
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const socket = yield* request.upgrade;
      const writer = yield* socket.writer;
      const reader = yield* socket.reader;
      const outgoing = yield* Queue.unbounded<string | Uint8Array>();
      const connection = voice.hub.connect({
        send: (message) =>
          Queue.offerUnsafe(
            outgoing,
            message instanceof Uint8Array ? message : JSON.stringify(message),
          ),
      });
      yield* Effect.addFinalizer(() => Effect.sync(() => connection.close()));
      yield* Effect.promise(() => voice.clientConnected());
      if (!voice.available()) {
        yield* writer.write(
          JSON.stringify({
            type: "error",
            text: "语音服务还没开通：这台电脑要登录 fwai 并开启远程连接。",
          }),
        );
      }
      const send = Effect.forever(Queue.take(outgoing).pipe(Effect.flatMap(writer.write)));
      const receive = Effect.forever(
        reader.pull.pipe(
          Effect.flatMap((chunks) =>
            Effect.sync(() => {
              for (const chunk of chunks) connection.receive(chunk);
            }),
          ),
        ),
      );
      return yield* Effect.raceFirst(send, receive);
    }),
  ).pipe(Effect.orElseSucceed(() => HttpServerResponse.empty()));
});

const pageHandler = (voice: Voice) =>
  Effect.succeed(
    HttpServerResponse.text(voice.page, {
      contentType: "text/html; charset=utf-8",
      headers: { "cache-control": "no-store" },
    }),
  );

/** Testing aid: the app acts as if its headset button was pressed. */
const pressHandler = Effect.fnUntraced(function* (voice: Voice) {
  yield* authenticateMediaRequest(AuthOrchestrationOperateScope);
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(request);
  const action = Option.isSome(url) ? (url.value.searchParams.get("action") ?? "pause") : "pause";
  voice.hub.broadcast({ type: "remote_press", action });
  return HttpServerResponse.text(`sent ${action} to ${voice.hub.size} client(s)\n`);
});

export const routeLayer = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const voice = yield* makeVoice;
    yield* router.add("GET", "/voice", pageHandler(voice));
    yield* router.add(
      "GET",
      "/voice/ws",
      socketHandler(voice).pipe(
        Effect.orElseSucceed(() => HttpServerResponse.text("Unauthorized", { status: 401 })),
      ),
    );
    yield* router.add(
      "POST",
      "/voice/debug/press",
      pressHandler(voice).pipe(
        Effect.orElseSucceed(() => HttpServerResponse.text("Unauthorized", { status: 401 })),
      ),
    );
  }),
);
