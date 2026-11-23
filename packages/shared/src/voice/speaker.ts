/** Announcement queue: speaks one message at a time and stays quiet while the user talks. */
import { TTS_SAMPLE_RATE, type VoiceConfig } from "./config.ts";

/** Where speech goes: the connected pages and apps. */
export interface VoicePlayer {
  play(chunks: AsyncIterable<Uint8Array>, sampleRate: number): Promise<void>;
  /** Cut current speech off (the user started talking). */
  stop(): void;
  /** A short tone instead of words: "chime" = news went to the inbox, "sent" = delivered. */
  cue(name: CueName): void;
}

export type CueName = "chime" | "sent";

export interface SpeakerPort {
  readonly last: string | null;
  say(
    text: string,
    options?: { readonly urgent?: boolean; readonly followup?: string | null },
  ): void;
  cue(name: CueName): void;
}

interface Item {
  readonly text: string;
  /** Thread id this is news from: the clients listen for a reply right after it. */
  readonly followup: string | null;
}

export class Speaker implements SpeakerPort {
  private queue: Array<Item> = [];
  private wake: (() => void) | null = null;
  private quiet = true;
  private quietWaiters: Array<() => void> = [];
  last: string | null = null;

  private readonly config: () => VoiceConfig;
  private readonly speak: (config: VoiceConfig, text: string) => AsyncIterable<Uint8Array>;
  private readonly player: VoicePlayer;
  private readonly onSay: (text: string, followup: string | null) => void;

  constructor(
    config: () => VoiceConfig,
    speak: (config: VoiceConfig, text: string) => AsyncIterable<Uint8Array>,
    player: VoicePlayer,
    onSay: (text: string, followup: string | null) => void,
  ) {
    this.config = config;
    this.speak = speak;
    this.player = player;
    this.onSay = onSay;
  }

  /** Queue `text`. Urgent messages (direct replies to a command) jump the queue. */
  say(
    text: string,
    options?: { readonly urgent?: boolean; readonly followup?: string | null },
  ): void {
    if (!text) return;
    const item = { text, followup: options?.followup ?? null };
    if (options?.urgent) this.queue.unshift(item);
    else this.queue.push(item);
    this.wake?.();
  }

  /** The user started talking: cut current speech and pause the queue. */
  hold(): void {
    this.quiet = false;
    this.player.stop();
  }

  release(): void {
    this.quiet = true;
    for (const resolve of this.quietWaiters.splice(0)) resolve();
  }

  cue(name: CueName): void {
    if (this.quiet) this.player.cue(name); // never beep into the mic
  }

  private async next(): Promise<Item> {
    while (this.queue.length === 0) await new Promise<void>((resolve) => (this.wake = resolve));
    this.wake = null;
    return this.queue.shift()!;
  }

  /** Runs until `signal` aborts. */
  async run(signal: AbortSignal, onError: (error: unknown) => void): Promise<void> {
    while (!signal.aborted) {
      const item = await this.next();
      if (!this.quiet) await new Promise<void>((resolve) => this.quietWaiters.push(resolve));
      this.last = item.text;
      this.onSay(item.text, item.followup);
      try {
        await this.player.play(this.speak(this.config(), item.text), TTS_SAMPLE_RATE);
      } catch (error) {
        onError(error); // keep the loop alive whatever happens
      }
    }
  }
}
