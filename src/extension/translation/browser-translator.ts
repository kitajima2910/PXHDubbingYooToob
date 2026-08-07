import type { SubtitleSegment } from "../../shared/types";

interface BrowserTranslator {
  translate(text: string): Promise<string>;
  destroy?(): void;
}

interface BrowserTranslatorFactory {
  availability(options: { sourceLanguage: string; targetLanguage: string }): Promise<string>;
  create(options: { sourceLanguage: string; targetLanguage: string }): Promise<BrowserTranslator>;
}

export function inferSourceLanguage(text: string): string {
  if (/[぀-ヿ]/u.test(text)) return "ja";
  if (/[가-힯]/u.test(text)) return "ko";
  if (/[฀-๿]/u.test(text)) return "th";
  if (/[Ѐ-ӿ]/u.test(text)) return "ru";
  if (/[؀-ۿ]/u.test(text)) return "ar";
  if (/[一-鿿]/u.test(text)) return "zh";
  if (/[ăâđêôơưĂÂĐÊÔƠƯ]|[àáạảãèéẹẻẽìíịỉĩòóọỏõùúụủũỳýỵỷỹ]/iu.test(text)) return "vi";
  return "en";
}

export async function prepareBrowserTranslation(sourceLanguage = "en"): Promise<string> {
  const factory = (globalThis as typeof globalThis & { Translator?: BrowserTranslatorFactory }).Translator;
  if (!factory) throw new Error("Brave chưa hỗ trợ Translator API");
  const availability = await factory.availability({ sourceLanguage, targetLanguage: "vi" });
  if (availability === "unavailable") throw new Error(`Không hỗ trợ model ${sourceLanguage} → vi`);
  const translator = await factory.create({ sourceLanguage, targetLanguage: "vi" });
  translator.destroy?.();
  return availability === "available" ? "Dịch offline đã sẵn sàng" : "Đã tải model dịch offline";
}

export async function translateWithBrowser(segments: SubtitleSegment[]): Promise<SubtitleSegment[]> {
  const factory = (globalThis as typeof globalThis & { Translator?: BrowserTranslatorFactory }).Translator;
  if (!factory) throw new Error("Brave chưa hỗ trợ Translator API chạy trên máy");
  const groups = new Map<string, SubtitleSegment[]>();
  for (const segment of segments) {
    const language = inferSourceLanguage(segment.sourceText);
    const group = groups.get(language) ?? [];
    group.push(segment);
    groups.set(language, group);
  }
  const translated: SubtitleSegment[] = [];
  for (const [sourceLanguage, group] of groups) {
    if (sourceLanguage === "vi") {
      translated.push(...group.map((segment) => ({ ...segment, translatedText: segment.sourceText })));
      continue;
    }
    const availability = await factory.availability({ sourceLanguage, targetLanguage: "vi" });
    if (availability === "unavailable") throw new Error(`Brave không có model dịch ${sourceLanguage} → vi`);
    const translator = await factory.create({ sourceLanguage, targetLanguage: "vi" });
    try {
      for (const segment of group) {
        const translatedText = (await translator.translate(segment.sourceText)).trim();
        if (!translatedText) throw new Error("Translator API trả bản dịch rỗng");
        translated.push({ ...segment, translatedText });
      }
    } finally { translator.destroy?.(); }
  }
  const byId = new Map(translated.map((segment) => [segment.id, segment]));
  return segments.map((segment) => byId.get(segment.id) ?? segment);
}
