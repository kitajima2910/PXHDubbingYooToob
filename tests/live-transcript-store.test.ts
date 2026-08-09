import { describe, expect, it } from "vitest";
import { LiveTranscriptStore } from "../src/extension/live-transcript-store";

describe("LiveTranscriptStore", () => {
  it("updates one partial record and keeps its original start time", () => {
    const store = new LiveTranscriptStore();
    store.upsert("u1", 1000, 1300, "hello", "partial");
    store.upsert("u1", 1200, 1800, "hello world", "partial");
    expect(store.get("u1")).toMatchObject({ startMs: 1000, endMs: 1800, sourceText: "hello world", status: "partial" });
    expect(store.recent()).toHaveLength(1);
  });

  it("keeps a usable translation while the source hypothesis advances", () => {
    const store = new LiveTranscriptStore();
    store.upsert("u1", 1000, 1300, "hello", "partial");
    store.setTranslation("u1", "hello", "xin chào");
    store.upsert("u1", 1000, 1800, "hello world", "partial");
    expect(store.get("u1")).toMatchObject({ sourceText: "hello world", translatedText: "xin chào", translatedSourceText: "hello" });
  });

  it("finalizes the same record instead of creating duplicates", () => {
    const store = new LiveTranscriptStore();
    store.upsert("u1", 1000, 1300, "xin", "partial");
    store.upsert("u1", 1000, 2200, "xin chao", "final");
    expect(store.recent()).toEqual([expect.objectContaining({ id: "u1", status: "final", sourceText: "xin chao" })]);
  });
});
