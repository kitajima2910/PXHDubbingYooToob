import Groq from "groq-sdk";

export interface TranslationInput { id: string; sourceText: string }
export interface TranslationOutput { id: string; translatedText: string }
export interface TranslationProvider { translate(items: TranslationInput[], signal: AbortSignal): Promise<TranslationOutput[]> }

export class GroqTranslationProvider implements TranslationProvider {
  async translate(items: TranslationInput[], signal: AbortSignal): Promise<TranslationOutput[]> {
    const key = process.env.GROQ_API_KEY;
    if (!key) throw new Error("Backend chưa cấu hình GROQ_API_KEY");
    const client = new Groq({ apiKey: key });
    const response = await client.chat.completions.create({
      model: process.env.GROQ_TRANSLATION_MODEL ?? "llama-3.3-70b-versatile",
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "Dịch tự nhiên sang tiếng Việt để đọc lồng tiếng. Giữ nguyên id, tên riêng, thuật ngữ và số liệu; viết ngắn gọn; không giải thích. Trả JSON dạng {\"segments\":[{\"id\":\"...\",\"translatedText\":\"...\"}]}" },
        { role: "user", content: JSON.stringify({ segments: items }) },
      ],
    }, { signal });
    const parsed = JSON.parse(response.choices[0]?.message.content ?? "{}") as { segments?: TranslationOutput[] };
    if (!Array.isArray(parsed.segments)) throw new Error("Kết quả dịch không hợp lệ");
    return parsed.segments;
  }
}
