// @effect-diagnostics nodeBuiltinImport:off - plain-TS voice core, tested without an Effect runtime.
import * as NodeFS from "node:fs";

/** What the voice assistant needs from server settings, flattened for the plain-TS core. */
export interface VoiceConfig {
  /**
   * Doubao Agent Plan key for calling Doubao directly (development). Without it, speech
   * and the LLM go through the relay, which holds the keys.
   */
  readonly doubaoApiKey: string;
  /** The linked relay, filled in at runtime (never from the config file). */
  readonly relay?: VoiceRelay | null;
  readonly asrUrl: string;
  readonly asrResourceId: string;
  readonly ttsUrl: string;
  readonly ttsResourceId: string;
  readonly ttsSpeaker: string;
  readonly ttsSpeechRate: number;
  readonly llmBaseUrl: string;
  readonly llmModel: string;
  readonly llmDisableThinking: boolean;
  /** Pause that ends a hands-free turn. */
  readonly silenceSeconds: number;
  /** How long the mic stays open for a reply after news is played. */
  readonly followupSeconds: number;
  /** T3 send mode for messages: auto steers a running turn or queues. */
  readonly sendMode: "auto" | "queue" | "steer" | "restart";
  /** Runtime mode for sessions opened by voice (voice cannot grant approvals). */
  readonly newSessionMode: "approval-required" | "auto-accept-edits" | "auto" | "full-access";
  /** Spoken names from settings: alias → substring of a thread title, project name or id. */
  readonly aliases: Readonly<Record<string, string>>;
}

export interface VoiceRelay {
  /** Relay origin, e.g. https://relay.fwaii-tunnel.com. */
  readonly url: string;
  /** This environment's relay credential. */
  readonly credential: string;
}

/** Where Doubao calls go: straight to Doubao with a local key, or through the relay. */
export type DoubaoAccess =
  | { readonly kind: "direct"; readonly apiKey: string }
  | { readonly kind: "relay"; readonly base: string; readonly credential: string };

export const RELAY_VOICE_PATH = "/v1/environment/voice";

export function doubaoAccess(config: VoiceConfig): DoubaoAccess | null {
  if (config.doubaoApiKey) return { kind: "direct", apiKey: config.doubaoApiKey };
  if (config.relay)
    return {
      kind: "relay",
      base: `${config.relay.url.replace(/\/+$/, "")}${RELAY_VOICE_PATH}`,
      credential: config.relay.credential,
    };
  return null;
}

export const DEFAULT_VOICE_CONFIG: VoiceConfig = {
  doubaoApiKey: "",
  // Agent Plan endpoints: the pay-as-you-go /api/v3 bills separately.
  asrUrl: "wss://openspeech.bytedance.com/api/v3/plan/sauc/bigmodel_nostream",
  asrResourceId: "volc.seedasr.sauc.duration",
  ttsUrl: "https://openspeech.bytedance.com/api/v3/plan/tts/unidirectional",
  ttsResourceId: "seed-tts-2.0",
  ttsSpeaker: "zh_female_vv_uranus_bigtts",
  ttsSpeechRate: 15,
  llmBaseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3",
  llmModel: "deepseek-v4.1-flash-economy",
  llmDisableThinking: true,
  silenceSeconds: 2,
  followupSeconds: 1.5,
  sendMode: "auto",
  newSessionMode: "full-access",
  aliases: {},
};

/**
 * `voice/config.json` in the server's state directory: any VoiceConfig field, in the
 * same names. T3CODE_FWAI_DOUBAO_API_KEY overrides the key so it can stay out of files.
 */
export function loadVoiceConfig(
  path: string,
  env: Readonly<Record<string, string | undefined>>,
): VoiceConfig {
  let file: Partial<VoiceConfig> = {};
  try {
    file = JSON.parse(NodeFS.readFileSync(path, "utf8")) as Partial<VoiceConfig>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const known = Object.fromEntries(
    Object.entries(file).filter(([key]) => key in DEFAULT_VOICE_CONFIG),
  );
  const config = { ...DEFAULT_VOICE_CONFIG, ...known } as VoiceConfig;
  const key = env.T3CODE_FWAI_DOUBAO_API_KEY?.trim();
  return key ? { ...config, doubaoApiKey: key } : config;
}
