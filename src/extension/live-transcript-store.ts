import type { SubtitleSegment } from "../shared/types";

export interface LiveTranscriptRecord extends SubtitleSegment {
  status: "partial" | "final";
  translatedSourceText?: string;
}

export class LiveTranscriptStore {
  private readonly records = new Map<string, LiveTranscriptRecord>();
  private readonly order: string[] = [];

  upsert(id: string, startMs: number, endMs: number, sourceText: string, status: "partial" | "final"): LiveTranscriptRecord {
    const existing = this.records.get(id);
    const record: LiveTranscriptRecord = {
      id,
      startMs: existing?.startMs ?? startMs,
      endMs: Math.max(existing?.endMs ?? endMs, endMs),
      sourceText: sourceText.trim(),
      status,
      ...(existing?.translatedText ? { translatedText: existing.translatedText } : {}),
      ...(existing?.translatedSourceText ? { translatedSourceText: existing.translatedSourceText } : {}),
    };
    if (!existing) this.order.push(id);
    this.records.set(id, record);
    while (this.order.length > 80) this.records.delete(this.order.shift()!);
    return record;
  }

  setTranslation(id: string, translatedSourceText: string, translatedText: string): LiveTranscriptRecord | undefined {
    const existing = this.records.get(id);
    if (!existing || !translatedText.trim()) return existing;
    const updated = { ...existing, translatedSourceText, translatedText: translatedText.trim() };
    this.records.set(id, updated);
    return updated;
  }

  get(id: string): LiveTranscriptRecord | undefined { return this.records.get(id); }

  recent(limit = 2): LiveTranscriptRecord[] {
    return this.order.slice(-limit).map((id) => this.records.get(id)).filter((item): item is LiveTranscriptRecord => Boolean(item));
  }

  clear(): void { this.records.clear(); this.order.length = 0; }
}
