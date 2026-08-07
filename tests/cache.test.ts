import { describe, expect, it } from "vitest";
import { cacheConfigured, canonicalizeTranslationSource, contentHash, readTranscript, transcriptCacheConfigured, translationCacheConfigured } from "../src/api/cache/store";

describe("khóa cache", () => {
  it("ổn định khi nội dung chỉ khác khoảng trắng", () => {
    expect(contentHash("Hello   world")).toBe(contentHash("Hello world"));
  });

  it("khác nhau khi nội dung thay đổi", () => {
    expect(contentHash("Hello world")).not.toBe(contentHash("Hello again"));
  });

  it("canonical key dùng chung cho khác biệt an toàn về kiểu chữ và dấu câu cuối", () => {
    expect(canonicalizeTranslationSource("  Hello   WORLD!!! ")).toBe("hello world");
    expect(canonicalizeTranslationSource("It’s ready.")).toBe("it's ready");
    expect(canonicalizeTranslationSource("version 1.2")).not.toBe(canonicalizeTranslationSource("version 12"));
    expect(canonicalizeTranslationSource("I don't agree")).not.toBe(canonicalizeTranslationSource("I agree"));
  });

  it("bỏ qua cache an toàn khi chưa cấu hình Neon", async () => {
    const databaseUrl = process.env.DATABASE_URL;
    const neonDatabaseUrl = process.env.NEON_DATABASE_URL;
    const dubbingDatabaseUrl = process.env.DUBBING_DATABASE_URL;
    delete process.env.DATABASE_URL;
    delete process.env.NEON_DATABASE_URL;
    delete process.env.DUBBING_DATABASE_URL;
    try {
      expect(cacheConfigured()).toBe(false);
      await expect(readTranscript({ videoId: "abcdefghijk", sourceLanguage: "auto" })).resolves.toEqual({ segments: [], complete: false });
    } finally {
      if (databaseUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = databaseUrl;
      if (neonDatabaseUrl === undefined) delete process.env.NEON_DATABASE_URL; else process.env.NEON_DATABASE_URL = neonDatabaseUrl;
      if (dubbingDatabaseUrl === undefined) delete process.env.DUBBING_DATABASE_URL; else process.env.DUBBING_DATABASE_URL = dubbingDatabaseUrl;
    }
  });

  it("tách cấu hình kho dịch global khỏi transcript theo video", () => {
    const databaseUrl = process.env.DATABASE_URL;
    const neonDatabaseUrl = process.env.NEON_DATABASE_URL;
    const dubbingDatabaseUrl = process.env.DUBBING_DATABASE_URL;
    delete process.env.DATABASE_URL;
    delete process.env.NEON_DATABASE_URL;
    process.env.DUBBING_DATABASE_URL = "postgresql://global.example/database";
    try {
      expect(transcriptCacheConfigured()).toBe(false);
      expect(translationCacheConfigured()).toBe(true);
      expect(cacheConfigured()).toBe(true);
    } finally {
      if (databaseUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = databaseUrl;
      if (neonDatabaseUrl === undefined) delete process.env.NEON_DATABASE_URL; else process.env.NEON_DATABASE_URL = neonDatabaseUrl;
      if (dubbingDatabaseUrl === undefined) delete process.env.DUBBING_DATABASE_URL; else process.env.DUBBING_DATABASE_URL = dubbingDatabaseUrl;
    }
  });
});
