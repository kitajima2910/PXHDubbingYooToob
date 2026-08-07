import { describe, expect, it } from "vitest";
import { cacheConfigured, contentHash, readTranscript } from "../src/api/cache/store";

describe("khóa cache", () => {
  it("ổn định khi nội dung chỉ khác khoảng trắng", () => {
    expect(contentHash("Hello   world")).toBe(contentHash("Hello world"));
  });

  it("khác nhau khi nội dung thay đổi", () => {
    expect(contentHash("Hello world")).not.toBe(contentHash("Hello again"));
  });

  it("bỏ qua cache an toàn khi chưa cấu hình Neon", async () => {
    const databaseUrl = process.env.DATABASE_URL;
    const neonDatabaseUrl = process.env.NEON_DATABASE_URL;
    delete process.env.DATABASE_URL;
    delete process.env.NEON_DATABASE_URL;
    try {
      expect(cacheConfigured()).toBe(false);
      await expect(readTranscript({ videoId: "abcdefghijk", sourceLanguage: "auto" })).resolves.toEqual({ segments: [], complete: false });
    } finally {
      if (databaseUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = databaseUrl;
      if (neonDatabaseUrl === undefined) delete process.env.NEON_DATABASE_URL; else process.env.NEON_DATABASE_URL = neonDatabaseUrl;
    }
  });
});
