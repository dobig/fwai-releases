// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - plain-TS voice core, tested without an Effect runtime.
/**
 * Doubao streaming ASR over its v3 binary WebSocket protocol. `bigmodel_nostream` answers
 * after the last packet: more accurate, and measured faster than the two-pass endpoint
 * (0.73 s vs 1.05 s after the last audio).
 */
import * as NodeCrypto from "node:crypto";
import * as NodeZlib from "node:zlib";

import WebSocket from "ws";

import { doubaoAccess, type VoiceConfig } from "./config.ts";

export const ASR_SAMPLE_RATE = 16_000;

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
const GZIP = 0b0001;

export function encodeFrame(
  messageType: number,
  flags: number,
  payload: Uint8Array,
  options: { readonly json: boolean },
): Buffer {
  const header = Buffer.from([
    VERSION_AND_SIZE,
    (messageType << 4) | flags,
    ((options.json ? JSON_SERIALIZATION : 0) << 4) | GZIP,
    0,
  ]);
  const body = NodeZlib.gzipSync(payload);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(body.length);
  return Buffer.concat([header, size, body]);
}

export interface DecodedFrame {
  readonly type: number;
  readonly flags: number;
  readonly sequence: number | null;
  readonly payload?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

export function decodeFrame(frame: Buffer): DecodedFrame {
  const headerSize = (frame[0]! & 0x0f) * 4;
  const type = frame[1]! >> 4;
  const flags = frame[1]! & 0x0f;
  const serialization = frame[2]! >> 4;
  const compression = frame[2]! & 0x0f;
  let rest = frame.subarray(headerSize);
  if (type === SERVER_ERROR) {
    const code = rest.readUInt32BE(0);
    const size = rest.readUInt32BE(4);
    return {
      type,
      flags,
      sequence: null,
      error: { code, message: rest.subarray(8, 8 + size).toString("utf8") },
    };
  }
  let sequence: number | null = null;
  if (flags & FLAG_SEQUENCE) {
    sequence = rest.readInt32BE(0);
    rest = rest.subarray(4);
  }
  const size = rest.readUInt32BE(0);
  let payload: Buffer = rest.subarray(4, 4 + size);
  if (compression === GZIP && payload.length > 0) payload = NodeZlib.gunzipSync(payload);
  return {
    type,
    flags,
    sequence,
    payload:
      serialization === JSON_SERIALIZATION && payload.length > 0
        ? JSON.parse(payload.toString("utf8"))
        : payload,
  };
}

export const isLast = (decoded: DecodedFrame): boolean => (decoded.flags & FLAG_LAST) !== 0;

class AsrError extends Error {}

/**
 * Stream PCM chunks (16 kHz, s16le, mono) to Doubao and return the final text.
 * `chunks` must end when the turn ends. `hotwords` (session names, aliases) nudge
 * recognition toward those words.
 */
export async function transcribe(
  config: VoiceConfig,
  chunks: AsyncIterable<Uint8Array>,
  hotwords: ReadonlyArray<string> = [],
): Promise<string> {
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
        ? { corpus: { context: JSON.stringify({ hotwords: hotwords.map((word) => ({ word })) }) } }
        : {}),
    },
  };
  const access = doubaoAccess(config);
  if (!access) throw new AsrError("语音识别没有可用的豆包配置");
  // Through the relay, it adds the key and resource id on its side.
  const ws =
    access.kind === "direct"
      ? new WebSocket(config.asrUrl, {
          headers: {
            "X-Api-Key": access.apiKey,
            "X-Api-Resource-Id": config.asrResourceId,
            "X-Api-Request-Id": NodeCrypto.randomUUID(),
            "X-Api-Connect-Id": NodeCrypto.randomUUID(),
            "X-Api-Sequence": "-1",
          },
          maxPayload: 0,
        })
      : new WebSocket(`${access.base.replace(/^http/, "ws")}/asr`, {
          headers: { Authorization: `Bearer ${access.credential}` },
          maxPayload: 0,
        });
  let logid: string | undefined;
  ws.once("upgrade", (response) => {
    const value = response.headers["x-tt-logid"];
    logid = Array.isArray(value) ? value[0] : value;
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });

  let text = "";
  const finished = new Promise<void>((resolve, reject) => {
    ws.on("message", (data, isBinary) => {
      if (!isBinary) return;
      const decoded = decodeFrame(data as Buffer);
      if (decoded.error) {
        reject(
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
      if (isLast(decoded)) resolve();
    });
    ws.once("error", reject);
    // Closing before the last packet is a failure, not an empty transcript.
    ws.once("close", (code, reason) =>
      reject(
        new AsrError(
          `豆包语音识别连接提前关闭 ${code} ${reason.toString("utf8")} (logid=${logid})`.trim(),
        ),
      ),
    );
  });
  let failed: unknown;
  finished.catch((error) => {
    failed = error;
  });

  try {
    ws.send(
      encodeFrame(FULL_CLIENT_REQUEST, FLAG_NONE, Buffer.from(JSON.stringify(request)), {
        json: true,
      }),
    );
    // Hold one chunk back so the last one can carry the "last packet" flag.
    let pending: Uint8Array | null = null;
    for await (const chunk of chunks) {
      if (failed) break;
      if (pending) ws.send(encodeFrame(AUDIO_ONLY_REQUEST, FLAG_NONE, pending, { json: false }));
      pending = chunk;
    }
    if (failed) throw failed;
    ws.send(
      encodeFrame(AUDIO_ONLY_REQUEST, FLAG_LAST, pending ?? new Uint8Array(), { json: false }),
    );
    await withTimeout(finished, 15_000, "豆包语音识别超时");
    return text.trim();
  } finally {
    ws.close();
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new AsrError(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
