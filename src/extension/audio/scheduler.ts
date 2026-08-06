import type { SubtitleSegment } from "../../shared/types";

interface ScheduledAudio { segment: SubtitleSegment; url: string }
const MAX_OVERRUN_MS = 3_000;
const MAX_START_LATENESS_MS = 5_000;
const MIN_SMOOTH_RATE = 0.95;
const MAX_SMOOTH_RATE = 1.15;

export function speechPlaybackRate(audioDurationSeconds: number, slotDurationMs: number, videoRate: number): number {
  const naturalRate = !Number.isFinite(audioDurationSeconds) || audioDurationSeconds <= 0
    ? 1
    : audioDurationSeconds / Math.max(0.5, slotDurationMs / 1000);
  const smoothRate = Math.min(MAX_SMOOTH_RATE, Math.max(MIN_SMOOTH_RATE, naturalRate));
  return Math.min(1.3, Math.max(0.85, smoothRate * videoRate));
}

export class AudioScheduler {
  private readonly items = new Map<string, ScheduledAudio>();
  private active: { id: string; audio: HTMLAudioElement } | undefined;
  private readonly played = new Set<string>();
  private frame = 0;
  private originalVolume: number;

  constructor(private readonly video: HTMLVideoElement, private sourceVolume: number) {
    this.originalVolume = video.volume;
    video.addEventListener("pause", this.onPause);
    video.addEventListener("play", this.onResume);
    video.addEventListener("seeking", this.onSeek);
    video.addEventListener("ratechange", this.onRateChange);
  }

  setSourceVolume(value: number): void {
    this.sourceVolume = value;
    if (this.frame) this.video.volume = Math.min(this.originalVolume, this.sourceVolume);
  }
  add(segment: SubtitleSegment, blob: Blob): void {
    const previous = this.items.get(segment.id);
    if (previous) URL.revokeObjectURL(previous.url);
    this.items.set(segment.id, { segment, url: URL.createObjectURL(blob) });
  }

  start(): void {
    this.stopLoop();
    this.video.volume = Math.min(this.originalVolume, this.sourceVolume);
    const tick = (): void => {
      const now = this.video.currentTime * 1000;
      if (this.active && now > Number(this.active.audio.dataset.endMs) + MAX_OVERRUN_MS) this.finishActive();
      const match = !this.active ? [...this.items.values()].find(({ segment }) =>
        now >= segment.startMs
        && now < segment.endMs
        && now - segment.startMs <= MAX_START_LATENESS_MS
        && !this.played.has(segment.id)) : undefined;
      if (match && !this.video.paused) this.play(match);
      this.frame = requestAnimationFrame(tick);
    };
    this.frame = requestAnimationFrame(tick);
  }

  private play(item: ScheduledAudio): void {
    this.stopActive();
    const audio = new Audio(item.url);
    const slotDuration = Math.max(500, item.segment.endMs - item.segment.startMs);
    audio.preload = "auto";
    audio.dataset.baseRate = "1";
    audio.playbackRate = speechPlaybackRate(0, slotDuration, this.video.playbackRate);
    audio.addEventListener("loadedmetadata", () => {
      const baseRate = speechPlaybackRate(audio.duration, slotDuration, 1);
      audio.dataset.baseRate = String(baseRate);
      audio.playbackRate = Math.min(1.3, Math.max(0.85, baseRate * this.video.playbackRate));
    }, { once: true });
    audio.dataset.endMs = String(item.segment.endMs);
    audio.addEventListener("ended", () => this.finishActive(), { once: true });
    void audio.play().catch(() => this.stopActive());
    this.active = { id: item.segment.id, audio };
  }

  private stopActive(): void {
    if (!this.active) return;
    this.active.audio.pause();
    this.active = undefined;
  }

  private finishActive(): void { if (this.active) this.played.add(this.active.id); this.stopActive(); }
  private readonly onPause = (): void => { this.active?.audio.pause(); };
  private readonly onResume = (): void => { if (this.active) void this.active.audio.play().catch(() => this.stopActive()); };
  private readonly onSeek = (): void => { this.stopActive(); this.played.clear(); };
  private readonly onRateChange = (): void => {
    if (this.active) {
      const baseRate = Number(this.active.audio.dataset.baseRate ?? 1);
      this.active.audio.playbackRate = Math.min(1.3, Math.max(0.85, baseRate * this.video.playbackRate));
    }
  };

  stopLoop(): void { if (this.frame) cancelAnimationFrame(this.frame); this.frame = 0; this.stopActive(); }
  clear(): void {
    this.stopLoop();
    this.video.volume = this.originalVolume;
    this.video.removeEventListener("pause", this.onPause); this.video.removeEventListener("play", this.onResume);
    this.video.removeEventListener("seeking", this.onSeek); this.video.removeEventListener("ratechange", this.onRateChange);
    for (const item of this.items.values()) URL.revokeObjectURL(item.url);
    this.items.clear(); this.played.clear();
  }
}
