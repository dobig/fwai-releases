// @effect-diagnostics nodeBuiltinImport:off - plain-TS voice core, tested without an Effect runtime.
/**
 * When a hands-free utterance is over. Speaking = the voice model hears a voice (knocks and
 * music don't count) at VOICE_RATIO of the user's own level: the headset mic is by their
 * mouth, so people nearby are much quieter. Without the model, loudness alone decides.
 */
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { ASR_SAMPLE_RATE } from "./doubaoAsr.ts";

export interface SpeechDetector {
  /** Probability that a 512-sample (32 ms) frame of 16 kHz audio holds speech. */
  probability(frame: Float32Array): Promise<number>;
}

export type EndVerdict = "end" | "timeout" | null;

const toInt16 = (chunk: Uint8Array) =>
  new Int16Array(chunk.buffer, chunk.byteOffset, Math.floor(chunk.byteLength / 2));

function rms(chunk: Uint8Array): number {
  const samples = toInt16(chunk);
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.sqrt(sum / samples.length);
}

/** False for the all-zero buffers a Bluetooth mic yields while it switches modes. */
export const isLive = (chunk: Uint8Array): boolean => toInt16(chunk).some((sample) => sample !== 0);

export class EndOfSpeech {
  static readonly MIN_SPEECH_RMS = 400; // loudness-only fallback
  static readonly MIN_VAD_RMS = 150; // with the model: just above silence, so soft speech counts
  static readonly VAD_THRESHOLD = 0.5;
  static readonly VOICE_RATIO = 0.3;
  private static readonly FRAME = 512;

  private elapsed = 0;
  private quietFor = 0;
  private floor: number | null = null;
  private voice: number | null = null; // running level of the user's own speech
  private pending: Array<number> = [];
  private probability = 0;
  heardSpeech = false;

  private readonly detector: SpeechDetector | null;
  private readonly silenceSeconds: number;
  private readonly startTimeout: number;
  private readonly maxSeconds: number;

  constructor(
    detector: SpeechDetector | null,
    silenceSeconds = 2,
    startTimeout = 6,
    maxSeconds = 30,
  ) {
    this.detector = detector;
    this.silenceSeconds = silenceSeconds;
    this.startTimeout = startTimeout;
    this.maxSeconds = maxSeconds;
  }

  private async speechProbability(chunk: Uint8Array): Promise<number> {
    for (const sample of toInt16(chunk)) this.pending.push(sample / 32768);
    const probabilities: Array<number> = [];
    while (this.pending.length >= EndOfSpeech.FRAME) {
      const frame = Float32Array.from(this.pending.splice(0, EndOfSpeech.FRAME));
      probabilities.push(await this.detector!.probability(frame));
    }
    if (probabilities.length > 0) this.probability = Math.max(...probabilities);
    return this.probability;
  }

  async feed(chunk: Uint8Array): Promise<EndVerdict> {
    const samples = toInt16(chunk).length;
    if (samples === 0) return null;
    const level = rms(chunk);
    const seconds = samples / ASR_SAMPLE_RATE;
    this.elapsed += seconds;
    this.floor = this.floor === null ? level : Math.min(this.floor, level);
    const own = this.voice === null ? 0 : this.voice * EndOfSpeech.VOICE_RATIO;
    const speaking =
      this.detector !== null
        ? (await this.speechProbability(chunk)) >= EndOfSpeech.VAD_THRESHOLD &&
          level > Math.max(EndOfSpeech.MIN_VAD_RMS, own)
        : level > Math.max(this.floor * 3, EndOfSpeech.MIN_SPEECH_RMS, own);
    if (speaking) {
      this.heardSpeech = true;
      this.quietFor = 0;
      this.voice = this.voice === null ? level : 0.8 * this.voice + 0.2 * level;
    } else {
      this.quietFor += seconds;
    }
    if (!this.heardSpeech) return this.elapsed >= this.startTimeout ? "timeout" : null;
    if (this.quietFor >= this.silenceSeconds || this.elapsed >= this.maxSeconds) return "end";
    return null;
  }
}

/**
 * Silero VAD v5 (MIT, silero_vad.onnx in ./assets) on onnxruntime-web's WASM build:
 * no native module to stage. Each session keeps recurrent state, so one per turn.
 */
export class SileroVad implements SpeechDetector {
  private state = new Float32Array(2 * 128);
  private context = new Float32Array(64); // v5 prepends the previous frame's last 64 samples

  private readonly ort: typeof import("onnxruntime-web");
  private readonly session: import("onnxruntime-web").InferenceSession;

  private constructor(
    ort: typeof import("onnxruntime-web"),
    session: import("onnxruntime-web").InferenceSession,
  ) {
    this.ort = ort;
    this.session = session;
  }

  static async load(): Promise<SileroVad> {
    const ort = await import("onnxruntime-web");
    ort.env.wasm.numThreads = 1;
    const assets = voiceAssetsDir();
    if (NodeFS.existsSync(NodePath.join(assets, "ort-wasm-simd-threaded.wasm")))
      ort.env.wasm.wasmPaths = `${assets}/`;
    const model = await NodeFSP.readFile(NodePath.join(assets, "silero_vad.onnx"));
    return new SileroVad(ort, await ort.InferenceSession.create(model));
  }

  async probability(frame: Float32Array): Promise<number> {
    const input = new Float32Array(this.context.length + frame.length);
    input.set(this.context);
    input.set(frame, this.context.length);
    const result = await this.session.run({
      input: new this.ort.Tensor("float32", input, [1, input.length]),
      state: new this.ort.Tensor("float32", this.state, [2, 1, 128]),
      sr: new this.ort.Tensor("int64", BigInt64Array.from([BigInt(ASR_SAMPLE_RATE)]), []),
    });
    this.state = new Float32Array(result.stateN!.data as Float32Array);
    this.context = frame.slice(-this.context.length);
    return (result.output!.data as Float32Array)[0] ?? 0;
  }
}

/** ./assets next to this module in source; the bundle copies it beside its own entry. */
export function voiceAssetsDir(): string {
  const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
  const candidates = [NodePath.join(here, "assets"), NodePath.join(here, "voice-assets")];
  return (
    candidates.find((dir) => NodeFS.existsSync(NodePath.join(dir, "silero_vad.onnx"))) ??
    candidates[0]!
  );
}

/** A fresh detector per turn, or null (loudness only) if the model can't load. */
export async function loadSpeechDetector(
  onError: (error: unknown) => void,
): Promise<SpeechDetector | null> {
  try {
    return await SileroVad.load();
  } catch (error) {
    onError(error);
    return null;
  }
}
