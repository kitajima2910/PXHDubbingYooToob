import { describe, expect, it } from "vitest";
import { inferSourceLanguage } from "../src/extension/translation/browser-translator";

describe("browser translator fallback", () => {
  it("nhận diện các nhóm chữ phổ biến trước khi tạo model dịch", () => {
    expect(inferSourceLanguage("Hello world")).toBe("en");
    expect(inferSourceLanguage("你好世界")).toBe("zh");
    expect(inferSourceLanguage("こんにちは")).toBe("ja");
    expect(inferSourceLanguage("안녕하세요")).toBe("ko");
    expect(inferSourceLanguage("Xin chào Việt Nam")).toBe("vi");
  });
});
