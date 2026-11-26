/**
 * When a hands-free utterance is over. Speaking = the voice model hears a voice (knocks and
 * music don't count) at VOICE_RATIO of the user's own level: the headset mic is by their
 * mouth, so people nearby are much quieter. Without the model, loudness alone decides.
 */
import { ASR_SAMPLE_RATE } from "./config.ts";

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
  /** Audio kept for recognition after the user's voice drops, so word tails are not cut. */
  static readonly HANGOVER_SECONDS = 0.5;
  private static readonly FRAME = 512;

  private elapsed = 0;
  private quietFor = 0;
  private floor: number | null = null;
  private voice: number | null = null; // running level of the user's own speech
  private pending: Array<number> = [];
  private probability = 0;
  heardSpeech = false;
  /** The user's level on this mic from earlier turns: audio well below it is not theirs. */
  private primed = false;
  /** Whether the last chunk fed should reach recognition. */
  keepLast = true;

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

  /**
   * The client's beep has been heard: the wait for a first word counts from here, not from
   * the first microphone frame, which reaches the server well before the beep reaches the user.
   */
  /**
   * Start from the user's level on this mic, learned in earlier turns: from the first word,
   * quieter voices (a video, people nearby) neither count as speech nor reach recognition.
   */
  prime(level: number): void {
    if (!(level > 0)) return;
    this.voice = level;
    this.primed = true;
  }

  /** The user's speaking level this turn, once they spoke. */
  get voiceLevel(): number | null {
    return this.heardSpeech ? this.voice : null;
  }

  restartStartTimeout(): void {
    if (!this.heardSpeech) this.elapsed = 0;
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
    this.keepLast =
      !this.primed ||
      speaking ||
      (this.heardSpeech && this.quietFor <= EndOfSpeech.HANGOVER_SECONDS);
    if (!this.heardSpeech) return this.elapsed >= this.startTimeout ? "timeout" : null;
    if (this.quietFor >= this.silenceSeconds || this.elapsed >= this.maxSeconds) return "end";
    return null;
  }
}
