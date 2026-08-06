export interface SubtitleSegment {
  id: string;
  startMs: number;
  endMs: number;
  sourceText: string;
  translatedText?: string;
}

export type DubbingStatus = "idle" | "loading" | "translating" | "speaking" | "ready" | "error";

export interface ExtensionState {
  enabled: boolean;
  status: DubbingStatus;
  message: string;
  processedSegments: number;
  source: string;
}
