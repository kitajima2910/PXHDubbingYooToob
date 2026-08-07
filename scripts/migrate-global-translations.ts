import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { neon } from "@neondatabase/serverless";
import { writeTranslations } from "../src/api/cache/store.js";

function loadLocalEnvironment(): void {
  try {
    for (const line of readFileSync(resolve(".env.local"), "utf8").split(/\r?\n/)) {
      const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
      if (match?.[1] && process.env[match[1]] === undefined) process.env[match[1]] = match[2] ?? "";
    }
  } catch { /* Biến môi trường có thể được cấp trực tiếp ở production. */ }
}

loadLocalEnvironment();
const sourceUrl = process.env.DATABASE_URL?.trim() || process.env.NEON_DATABASE_URL?.trim();
const targetUrl = process.env.DUBBING_DATABASE_URL?.trim();
if (!sourceUrl || !targetUrl) throw new Error("Cần DATABASE_URL và DUBBING_DATABASE_URL để migration");
if (sourceUrl === targetUrl) throw new Error("Database nguồn và kho dịch global phải khác nhau");

const source = neon(sourceUrl);
const rows = await source.query(`
  SELECT source_language, target_language, source_text, translated_text
  FROM pxh_dubbing.pxh_translation_cache
  ORDER BY updated_at
`) as Array<{ source_language: string; target_language: string; source_text: string; translated_text: string }>;

const groups = new Map<string, typeof rows>();
for (const row of rows) {
  const key = `${row.source_language}\u0000${row.target_language}`;
  const group = groups.get(key) ?? [];
  group.push(row);
  groups.set(key, group);
}

for (const [key, group] of groups) {
  const [sourceLanguage, targetLanguage] = key.split("\u0000");
  if (!sourceLanguage || !targetLanguage) continue;
  for (let index = 0; index < group.length; index += 500) {
    await writeTranslations(
      { sourceLanguage, targetLanguage },
      group.slice(index, index + 500).map((row) => ({ sourceText: row.source_text, translatedText: row.translated_text })),
    );
  }
}

console.log(`Đã chuyển ${rows.length} bản dịch vào kho global`);
