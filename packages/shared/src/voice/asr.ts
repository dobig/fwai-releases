// @effect-diagnostics globalTimers:off - plain-TS voice core, tested without an Effect runtime.
/**
 * Doubao streaming ASR over its v3 binary WebSocket protocol. `bigmodel_nostream` answers
 * after the last packet: more accurate, and measured faster than the two-pass endpoint
 * (0.73 s vs 1.05 s after the last audio). Frames go uncompressed both ways, so neither
 * side needs zlib; Doubao then answers uncompressed too.
 */
import { ASR_SAMPLE_RATE, doubaoAccess, type VoiceConfig } from "./config.ts";

const VERSION_AND_SIZE = 0x11; // protocol v1, 4-byte header
const FULL_CLIENT_REQUEST = 0b0001;
export const AUDIO_ONLY_REQUEST = 0b0010;
export const FULL_SERVER_RESPONSE = 0b1001;
const SERVER_ERROR = 0b1111;
const FLAG_NONE = 0b0000;
export const FLAG_SEQUENCE = 0b0001;
export const FLAG_LAST = 0b0010;
export const FLAG_LAST_WITH_SEQUENCE = 0b0011;
const JSON_SERIALIZATION = 0b0001;
const NO_COMPRESSION = 0b0000;

export function encodeFrame(
  messageType: number,
  flags: number,
  payload: Uint8Array,
  options: { readonly json: boolean },
): Uint8Array {
  const frame = new Uint8Array(8 + payload.length);
  frame.set([
    VERSION_AND_SIZE,
    (messageType << 4) | flags,
    ((options.json ? JSON_SERIALIZATION : 0) << 4) | NO_COMPRESSION,
    0,
  ]);
  new DataView(frame.buffer).setUint32(4, payload.length);
  frame.set(payload, 8);
  return frame;
}

export interface DecodedFrame {
  readonly type: number;
  readonly flags: number;
  readonly sequence: number | null;
  readonly payload?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

class AsrError extends Error {}

const utf8 = new TextDecoder();

export function decodeFrame(frame: Uint8Array): DecodedFrame {
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const headerSize = (frame[0]! & 0x0f) * 4;
  const type = frame[1]! >> 4;
  const flags = frame[1]! & 0x0f;
  const serialization = frame[2]! >> 4;
  const compression = frame[2]! & 0x0f;
  let offset = headerSize;
  if (type === SERVER_ERROR) {
    const code = view.getUint32(offset);
    const size = view.getUint32(offset + 4);
    return {
      type,
      flags,
      sequence: null,
      error: { code, message: utf8.decode(frame.subarray(offset + 8, offset + 8 + size)) },
    };
  }
  let sequence: number | null = null;
  if (flags & FLAG_SEQUENCE) {
    sequence = view.getInt32(offset);
    offset += 4;
  }
  const size = view.getUint32(offset);
  const payload = frame.subarray(offset + 4, offset + 4 + size);
  if (compression !== NO_COMPRESSION && payload.length > 0)
    throw new AsrError(`豆包语音识别返回了压缩数据 (${compression})`);
  return {
    type,
    flags,
    sequence,
    payload:
      serialization === JSON_SERIALIZATION && payload.length > 0
        ? JSON.parse(utf8.decode(payload))
        : payload,
  };
}

export const isLast = (decoded: DecodedFrame): boolean => (decoded.flags & FLAG_LAST) !== 0;

export interface AsrSocketHandlers {
  message(frame: Uint8Array): void;
  close(code: number, reason: string): void;
  error(error: unknown): void;
}

export interface AsrSocket {
  send(frame: Uint8Array): void;
  close(): void;
  /** Doubao's trace id, when the upgrade response carried one. */
  readonly logid?: string | undefined;
}

/** WebSockets differ between Node (`ws`) and React Native; each side brings its own. */
export interface AsrTransport {
  /** Resolves once the socket is open. Binary frames only. */
  open(
    url: string,
    headers: Record<string, string>,
    handlers: AsrSocketHandlers,
  ): Promise<AsrSocket>;
  randomId(): string;
}

export type Transcribe = (
  config: VoiceConfig,
  chunks: AsyncIterable<Uint8Array>,
  hotwords?: ReadonlyArray<string>,
) => Promise<string>;

/**
 * Stream PCM chunks (16 kHz, s16le, mono) to Doubao and return the final text.
 * `chunks` must end when the turn ends. `hotwords` (session names, aliases) nudge
 * recognition toward those words.
 */
export function makeTranscribe(transport: AsrTransport): Transcribe {
  return async (config, chunks, hotwords = []) => {
    const request: Record<string, unknown> = {
      user: { uid: "voice-pilot" },
      audio: { format: "pcm", codec: "raw", rate: ASR_SAMPLE_RATE, bits: 16, channel: 1 },
      request: {
        model_name: "bigmodel",
        enable_itn: true,
        enable_punc: true,
        enable_ddc: true,
        show_utterances: false,
        // Two-pass streaming: partial text while talking, each sentence re-recognized.
        ...(config.asrUrl.includes("bigmodel_async") ? { enable_nonstream: true } : {}),
        // Doubao wants this as a JSON *string*; hotwords plus context are capped at ~100 tokens.
        ...(hotwords.length > 0
          ? {
              corpus: {
                context: JSON.stringify({ hotwords: hotwords.map((word) => ({ word })) }),
              },
            }
          : {}),
      },
    };
    const access = doubaoAccess(config);
    if (!access) throw new AsrError("语音识别没有可用的豆包配置");

    let text = "";
    const settle: { resolve: () => void; reject: (error: unknown) => void } = {
      resolve: () => {},
      reject: () => {},
    };
    const finished = new Promise<void>((resolve, reject) => {
      settle.resolve = resolve;
      settle.reject = reject;
    });
    let failed: unknown;
    finished.catch((error) => {
      failed = error;
    });
    let logid: string | undefined;
    const handlers: AsrSocketHandlers = {
      message: (frame) => {
        let decoded: DecodedFrame;
        try {
          decoded = decodeFrame(frame);
        } catch (error) {
          settle.reject(error);
          return;
        }
        if (decoded.error) {
          settle.reject(
            new AsrError(
              `豆包语音识别出错 ${decoded.error.code}: ${decoded.error.message} (logid=${logid})`,
            ),
          );
          return;
        }
        const payload = decoded.payload as { result?: unknown } | undefined;
        let result = payload && typeof payload === "object" ? payload.result : undefined;
        if (Array.isArray(result)) result = result[0]; // some versions return a list
        if (
          result &&
          typeof result === "object" &&
          typeof (result as { text?: unknown }).text === "string"
        ) {
          text = (result as { text: string }).text;
        }
        if (isLast(decoded)) settle.resolve();
      },
      // Closing before the last packet is a failure, not an empty transcript.
      close: (code, reason) =>
        settle.reject(
          new AsrError(`豆包语音识别连接提前关闭 ${code} ${reason} (logid=${logid})`.trim()),
        ),
      error: (error) => settle.reject(error),
    };

    // Through the relay, it adds the key and resource id on its side.
    let socket: AsrSocket;
    if (access.kind === "direct") {
      socket = await transport.open(
        config.asrUrl,
        {
          "X-Api-Key": access.apiKey,
          "X-Api-Resource-Id": config.asrResourceId,
          "X-Api-Request-Id": transport.randomId(),
          "X-Api-Connect-Id": transport.randomId(),
          "X-Api-Sequence": "-1",
        },
        handlers,
      );
    } else {
      const url = `${access.base}/asr`;
      socket = await transport.open(
        url.replace(/^http/, "ws"),
        await access.authorize("GET", url),
        handlers,
      );
    }
    logid = socket.logid;

    try {
      socket.send(
        encodeFrame(
          FULL_CLIENT_REQUEST,
          FLAG_NONE,
          new TextEncoder().encode(JSON.stringify(request)),
          { json: true },
        ),
      );
      // Hold one chunk back so the last one can carry the "last packet" flag.
      let pending: Uint8Array | null = null;
      for await (const chunk of chunks) {
        if (failed) break;
        if (pending)
          socket.send(encodeFrame(AUDIO_ONLY_REQUEST, FLAG_NONE, pending, { json: false }));
        pending = chunk;
      }
      if (failed) throw failed;
      socket.send(
        encodeFrame(AUDIO_ONLY_REQUEST, FLAG_LAST, pending ?? new Uint8Array(), { json: false }),
      );
      await withTimeout(finished, 15_000, "豆包语音识别超时");
      return text.trim();
    } finally {
      socket.close();
    }
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new AsrError(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
