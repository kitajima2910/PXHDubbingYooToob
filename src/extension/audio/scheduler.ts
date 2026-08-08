import type { SubtitleSegment } from "../../shared/types";

interface ScheduledAudio { segment: SubtitleSegment; url?: string; text?: string }
const MIN_SMOOTH_RATE = 0.95;
const MAX_SMOOTH_RATE = 1.35;
const MAX_PLAYBACK_RATE = 1.5;

export function speechPlaybackRate(audioDurationSeconds: number, slotDurationMs: number, videoRate: number): number {
  const naturalRate = !Number.isFinite(audioDurationSeconds) || audioDurationSeconds <= 0
    ? 1
    : audioDurationSeconds / Math.max(0.5, slotDurationMs / 1000);
  const smoothRate = Math.min(MAX_SMOOTH_RATE, Math.max(MIN_SMOOTH_RATE, naturalRate));
  return Math.min(1.3, Math.max(0.85, smoothRate * videoRate));
}

export function speechCatchupRate(latenessMs: number): number {
  return 1 + Math.min(0.2, Math.max(0, latenessMs) / 40_000);
}

export function canStartSpeechAt(segment: SubtitleSegment, timelineMs: number): boolean {
  return timelineMs >= segment.startMs
    && timelineMs < segment.endMs - 250;
}

export class AudioScheduler {
  private readonly items = new Map<string, ScheduledAudio>();
  private active: { id: string; audio?: HTMLAudioElement; chromeTts?: boolean } | undefined;
  private readonly played = new Set<string>();
  private frame = 0;
  private originalVolume: number;
  private lastTimelineMs: number;

  constructor(
    private readonly video: HTMLVideoElement,
    private sourceVolume: number,
    private readonly createFallbackSpeech?: (segment: SubtitleSegment, text: string) => Promise<Blob>,
    private readonly webSpeechFallback?: (text: string, rate: number) => Promise<void>,
  ) {
    this.originalVolume = video.volume;
    this.lastTimelineMs = video.currentTime * 1000;
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
    if (previous?.url) URL.revokeObjectURL(previous.url);
    this.items.set(segment.id, { segment, url: URL.createObjectURL(blob) });
  }

  addSpeech(segment: SubtitleSegment, text: string): void {
    const previous = this.items.get(segment.id);
    if (previous?.url) URL.revokeObjectURL(previous.url);
    this.items.set(segment.id, { segment, text });
  }

  start(): void {
    this.stopLoop();
    this.video.volume = Math.min(this.originalVolume, this.sourceVolume);
    const tick = (): void => {
      const now = this.video.currentTime * 1000;
      for (const { segment } of this.items.values()) {
        if (!this.played.has(segment.id) && now >= segment.endMs - 250) {
          this.played.add(segment.id);
        }
      }
      const activeSegment = this.active ? this.items.get(this.active.id)?.segment : undefined;
      const replacementReady = [...this.items.values()].some(({ segment }) =>
        segment.id !== activeSegment?.id && !this.played.has(segment.id) && canStartSpeechAt(segment, now));
      if (activeSegment && now >= activeSegment.endMs && replacementReady) this.stopActive();
      const match = !this.active ? [...this.items.values()]
        .filter(({ segment }) => canStartSpeechAt(segment, now)
          && !this.played.has(segment.id))
        .sort((left, right) => left.segment.startMs - right.segment.startMs)[0] : undefined;
      if (match && !this.video.paused) this.play(match);
      this.lastTimelineMs = now;
      this.frame = requestAnimationFrame(tick);
    };
    this.frame = requestAnimationFrame(tick);
  }

  private play(item: ScheduledAudio): void {
    this.stopActive();
    // At-most-once trong một timeline: nếu play/resume lỗi, tick sau không được phát lại từ đầu.
    this.played.add(item.segment.id);
    const slotDuration = Math.max(500, item.segment.endMs - item.segment.startMs);
    const latenessMs = Math.max(0, this.video.currentTime * 1000 - item.segment.startMs);
    const remainingSlotDuration = Math.max(500, item.segment.endMs - this.video.currentTime * 1000);
    const catchupRate = speechCatchupRate(latenessMs);
    if (item.text !== undefined) {
      const estimatedDuration = Math.max(0.8, item.text.length / 14);
      const rate = Math.min(MAX_PLAYBACK_RATE, speechPlaybackRate(estimatedDuration, remainingSlotDuration, this.video.playbackRate) * catchupRate);
      this.active = { id: item.segment.id, chromeTts: true };
      void chrome.runtime.sendMessage({ action: "tts-speak", text: item.text, rate }).then(async (result: { ok?: boolean; message?: string }) => {
        if (this.active?.id !== item.segment.id) return;
        if (result?.ok) { this.finishActive(); return; }
        // Fallback: Web Speech API (client-side, không cần server)
        if (this.webSpeechFallback) {
          try {
            await this.webSpeechFallback(item.text!, rate);
            this.finishActive();
            return;
          } catch { /* continue to createFallbackSpeech */ }
        }
        if (!this.createFallbackSpeech) { console.warn("PXHDubbingYooToob: Chrome TTS lỗi", result?.message); this.stopActive(); return; }
        this.active = { id: item.segment.id };
        try {
          const blob = await this.createFallbackSpeech(item.segment, item.text!);
          if (this.active?.id !== item.segment.id) return;
          const fallback: ScheduledAudio = { segment: item.segment, url: URL.createObjectURL(blob) };
          this.items.set(item.segment.id, fallback);
          this.active = undefined;
          this.played.delete(item.segment.id);
          if (!this.video.paused && canStartSpeechAt(item.segment, this.video.currentTime * 1000)) this.play(fallback);
        } catch (error) {
          console.warn("PXHDubbingYooToob: TTS dự phòng lỗi", error);
          if (this.active?.id === item.segment.id) this.stopActive();
        }
      }, () => { if (this.active?.id === item.segment.id) this.stopActive(); });
      return;
    }
    if (!item.url) return;
    const audio = new Audio(item.url);
    audio.preload = "auto";
    audio.volume = 1;
    audio.dataset.baseRate = "1";
    audio.dataset.catchupRate = String(catchupRate);
    audio.playbackRate = Math.min(MAX_PLAYBACK_RATE, speechPlaybackRate(0, slotDuration, this.video.playbackRate) * catchupRate);
    audio.addEventListener("loadedmetadata", () => {
      const remainingMs = Math.max(500, item.segment.endMs - this.video.currentTime * 1000);
      const baseRate = speechPlaybackRate(audio.duration, remainingMs, 1);
      audio.dataset.baseRate = String(baseRate);
      audio.playbackRate = Math.min(MAX_PLAYBACK_RATE, Math.max(0.85, baseRate * this.video.playbackRate * catchupRate));
    }, { once: true });
    audio.addEventListener("ended", () => this.finishActive(), { once: true });
    void audio.play().catch(() => this.stopActive());
    this.active = { id: item.segment.id, audio };
  }

  private stopActive(): void {
    if (!this.active) return;
    this.active.audio?.pause();
    if (this.active.chromeTts) void chrome.runtime.sendMessage({ action: "tts-stop" });
    this.active = undefined;
  }

  private finishActive(): void { if (this.active) this.played.add(this.active.id); this.stopActive(); }
  private readonly onPause = (): void => {
    this.active?.audio?.pause();
    if (this.active?.chromeTts) void chrome.runtime.sendMessage({ action: "tts-pause" });
  };
  private readonly onResume = (): void => {
    if (this.active?.audio) void this.active.audio.play().catch(() => this.stopActive());
    else if (this.active?.chromeTts) void chrome.runtime.sendMessage({ action: "tts-resume" });
  };
  private readonly onSeek = (): void => {
    this.stopActive();
    const targetMs = this.video.currentTime * 1000;
    const seekingBackward = targetMs < this.lastTimelineMs - 750;
    for (const { segment } of this.items.values()) {
      if (seekingBackward && segment.startMs >= targetMs - 250) this.played.delete(segment.id);
      else if (segment.startMs < targetMs - 250) this.played.add(segment.id);
    }
    this.lastTimelineMs = targetMs;
  };
  private readonly onRateChange = (): void => {
    if (this.active?.audio) {
      const baseRate = Number(this.active.audio.dataset.baseRate ?? 1);
      const catchupRate = Number(this.active.audio.dataset.catchupRate ?? 1);
      this.active.audio.playbackRate = Math.min(MAX_PLAYBACK_RATE, Math.max(0.85, baseRate * this.video.playbackRate * catchupRate));
    }
  };

  stopLoop(): void { if (this.frame) cancelAnimationFrame(this.frame); this.frame = 0; this.stopActive(); }
  clear(): void {
    this.stopLoop();
    this.video.volume = this.originalVolume;
    this.video.removeEventListener("pause", this.onPause); this.video.removeEventListener("play", this.onResume);
    this.video.removeEventListener("seeking", this.onSeek); this.video.removeEventListener("ratechange", this.onRateChange);
    for (const item of this.items.values()) if (item.url) URL.revokeObjectURL(item.url);
    this.items.clear(); this.played.clear();
  }
}
