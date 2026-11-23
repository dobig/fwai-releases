// @effect-diagnostics globalFetch:off - plain-TS voice core, tested without an Effect runtime.
/**
 * Doubao TTS 2.0 over the HTTP chunked streaming endpoint: the response is a run of
 * JSON objects, each carrying a base64 chunk of 24 kHz mono s16le PCM in `data`, so
 * playback can start before synthesis finishes.
 */
import { doubaoAccess, TTS_SAMPLE_RATE, type VoiceConfig } from "./config.ts";

const FINISHED_CODE = 20_000_000;

class TtsError extends Error {}

export type Synthesize = (config: VoiceConfig, text: string) => AsyncIterable<Uint8Array>;

/** A fetch whose response body can be read as it arrives (`expo/fetch` on React Native). */
export type StreamingFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  readonly body: ReadableStream<Uint8Array> | null;
  text(): Promise<string>;
}>;

export function makeSynthesize(doFetch: StreamingFetch, randomId: () => string): Synthesize {
  return async function* synthesize(config, text) {
    const access = doubaoAccess(config);
    if (!access) throw new TtsError("语音合成没有可用的豆包配置");
    const url = access.kind === "direct" ? config.ttsUrl : `${access.base}/tts`;
    const response = await doFetch(url, {
      method: "POST",
      headers:
        access.kind === "direct"
          ? {
              "X-Api-Key": access.apiKey,
              "X-Api-Resource-Id": config.ttsResourceId,
              "X-Api-Request-Id": randomId(),
              "Content-Type": "application/json",
            }
          : { ...(await access.authorize("POST", url)), "Content-Type": "application/json" },
      body: JSON.stringify({
        user: { uid: "voice-pilot" },
        req_params: {
          text,
          speaker: config.ttsSpeaker,
          audio_params: {
            format: "pcm",
            sample_rate: TTS_SAMPLE_RATE,
            speech_rate: config.ttsSpeechRate,
          },
          additions: JSON.stringify({ disable_markdown_filter: false }),
        },
      }),
      signal: AbortSignal.timeout(60_000),
    });
    const logid = response.headers.get("X-Tt-Logid");
    if (!response.ok || response.body === null) {
      const detail = (await response.text()).slice(0, 300);
      throw new TtsError(`豆包语音合成 HTTP ${response.status}: ${detail} (logid=${logid})`);
    }
    const splitter = new JsonObjectSplitter();
    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const message of splitter.push(decoder.decode(value, { stream: true }))) {
          const {
            code = 0,
            data,
            message: detail,
          } = message as { code?: number; data?: string; message?: string };
          if (code !== 0 && code !== FINISHED_CODE)
            throw new TtsError(`豆包语音合成出错 ${code}: ${detail} (logid=${logid})`);
          if (data) yield decodeBase64(data);
        }
      }
    } finally {
      reader.releaseLock();
    }
  };
}

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_VALUES = new Int16Array(128).fill(-1);
for (let i = 0; i < BASE64.length; i++) BASE64_VALUES[BASE64.charCodeAt(i)] = i;

/** Standard base64 to bytes, without Buffer or atob (neither is everywhere). */
export function decodeBase64(text: string): Uint8Array {
  const clean = text.replace(/[^A-Za-z0-9+/]/g, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let value = 0;
  let index = 0;
  for (let i = 0; i < clean.length; i++) {
    value = (value << 6) | BASE64_VALUES[clean.charCodeAt(i)]!;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[index++] = (value >> bits) & 0xff;
    }
  }
  return out.subarray(0, index);
}

/** Splits a stream of concatenated JSON objects ("{...}{...}") as the text arrives. */
export class JsonObjectSplitter {
  private buffer = "";

  push(text: string): Array<unknown> {
    this.buffer += text;
    const objects: Array<unknown> = [];
    let depth = 0;
    let inString = false;
    let escaped = false;
    let start = -1;
    let consumed = 0;
    for (let i = 0; i < this.buffer.length; i++) {
      const char = this.buffer[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
      } else if (char === '"') inString = true;
      else if (char === "{") {
        if (depth === 0) start = i;
        depth++;
      } else if (char === "}" && depth > 0 && --depth === 0) {
        objects.push(JSON.parse(this.buffer.slice(start, i + 1)));
        consumed = i + 1;
      }
    }
    this.buffer = this.buffer.slice(consumed);
    return objects;
  }
}
