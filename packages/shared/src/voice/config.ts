/** Voice assistant settings, shared by the environment server and the mobile app. */

export const ASR_SAMPLE_RATE = 16_000;
export const TTS_SAMPLE_RATE = 24_000;

/** What the voice assistant needs from server settings, flattened for the plain-TS core. */
export interface VoiceConfig {
  /**
   * Doubao Agent Plan key for calling Doubao directly (development). Without it, speech
   * and the LLM go through the relay, which holds the keys.
   */
  readonly doubaoApiKey: string;
  /** The relay's voice routes, filled in at runtime (never from the config file). */
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
  /**
   * Where the voice routes are: `<relay>/v1/environment/voice` for an environment server,
   * `<relay>/v1/voice` for the mobile app.
   */
  readonly base: string;
  /**
   * Headers that authenticate one call: a bearer credential, or a DPoP token with a proof
   * for exactly this method and URL. Socket URLs are passed with an `https:` scheme.
   */
  readonly authorize: (method: string, url: string) => Promise<Record<string, string>>;
}

/** Where Doubao calls go: straight to Doubao with a local key, or through the relay. */
export type DoubaoAccess =
  | { readonly kind: "direct"; readonly apiKey: string }
  | ({ readonly kind: "relay" } & VoiceRelay);

export function doubaoAccess(config: VoiceConfig): DoubaoAccess | null {
  if (config.doubaoApiKey) return { kind: "direct", apiKey: config.doubaoApiKey };
  if (config.relay)
    return {
      kind: "relay",
      base: config.relay.base.replace(/\/+$/, ""),
      authorize: config.relay.authorize,
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
