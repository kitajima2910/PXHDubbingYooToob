import { createHash } from "node:crypto";
import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import type { SubtitleSegment } from "../../shared/types.js";

export interface CacheContext {
  videoId: string;
  sourceLanguage: string;
}

export interface TranslationCacheContext extends CacheContext {
  targetLanguage: string;
}

let schemaReady: Promise<void> | undefined;

function databaseUrl(): string | undefined {
  return process.env.DATABASE_URL?.trim() || process.env.NEON_DATABASE_URL?.trim() || undefined;
}

function database(): NeonQueryFunction<false, false> | undefined {
  const url = databaseUrl();
  return url ? neon(url) : undefined;
}

export function cacheConfigured(): boolean {
  return Boolean(databaseUrl());
}

export function contentHash(text: string): string {
  return createHash("sha256").update(text.replace(/\s+/g, " ").trim(), "utf8").digest("hex");
}

async function ensureSchema(sql: NeonQueryFunction<false, false>): Promise<void> {
  schemaReady ??= (async () => {
    await sql.query(`
      CREATE TABLE IF NOT EXISTS pxh_transcript_cache (
        video_id varchar(11) NOT NULL,
        source_language varchar(16) NOT NULL,
        segment_key char(64) NOT NULL,
        segment_id varchar(160) NOT NULL,
        start_ms bigint NOT NULL,
        end_ms bigint NOT NULL,
        source_text text NOT NULL,
        source varchar(80) NOT NULL,
        is_complete boolean NOT NULL DEFAULT false,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (video_id, source_language, segment_key)
      )
    `);
    await sql.query(`
      CREATE INDEX IF NOT EXISTS pxh_transcript_cache_timeline
      ON pxh_transcript_cache (video_id, source_language, start_ms)
    `);
    await sql.query(`
      CREATE TABLE IF NOT EXISTS pxh_translation_cache (
        video_id varchar(11) NOT NULL,
        source_language varchar(16) NOT NULL,
        target_language varchar(16) NOT NULL,
        source_hash char(64) NOT NULL,
        source_text text NOT NULL,
        translated_text text NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (video_id, source_language, target_language, source_hash)
      )
    `);
  })().catch((error) => { schemaReady = undefined; throw error; });
  await schemaReady;
}

export async function readTranscript(
  context: CacheContext,
  fromMs?: number,
  toMs?: number,
): Promise<{ segments: SubtitleSegment[]; source?: string; complete: boolean }> {
  const sql = database();
  if (!sql) return { segments: [], complete: false };
  await ensureSchema(sql);
  const rows = await sql.query(`
    SELECT segment_id, start_ms, end_ms, source_text, source, is_complete
    FROM pxh_transcript_cache
    WHERE video_id = $1 AND source_language = $2
      AND ($3::bigint IS NULL OR end_ms >= $3)
      AND ($4::bigint IS NULL OR start_ms <= $4)
    ORDER BY start_ms, segment_key
  `, [context.videoId, context.sourceLanguage, fromMs ?? null, toMs ?? null]) as Array<{
    segment_id: string; start_ms: string | number; end_ms: string | number; source_text: string; source: string; is_complete: boolean;
  }>;
  const source = rows[0]?.source;
  return {
    segments: rows.map((row) => ({
      id: row.segment_id,
      startMs: Number(row.start_ms),
      endMs: Number(row.end_ms),
      sourceText: row.source_text,
    })),
    ...(source ? { source } : {}),
    complete: rows.some((row) => row.is_complete),
  };
}

export async function writeTranscript(
  context: CacheContext,
  source: string,
  segments: SubtitleSegment[],
  complete: boolean,
): Promise<void> {
  const sql = database();
  if (!sql || !segments.length) return;
  await ensureSchema(sql);
  if (complete) {
    await sql.query("DELETE FROM pxh_transcript_cache WHERE video_id = $1 AND source_language = $2", [context.videoId, context.sourceLanguage]);
  }
  const payload = segments.map((segment) => ({
    segmentKey: contentHash(`${segment.startMs}:${segment.sourceText}`),
    segmentId: segment.id,
    startMs: Math.round(segment.startMs),
    endMs: Math.round(segment.endMs),
    sourceText: segment.sourceText,
  }));
  await sql.query(`
    INSERT INTO pxh_transcript_cache (
      video_id, source_language, segment_key, segment_id, start_ms, end_ms, source_text, source, is_complete
    )
    SELECT $1, $2, item.segment_key, item.segment_id, item.start_ms, item.end_ms, item.source_text, $3, $4
    FROM jsonb_to_recordset($5::jsonb) AS item(
      segment_key char(64), segment_id varchar(160), start_ms bigint, end_ms bigint, source_text text
    )
    ON CONFLICT (video_id, source_language, segment_key) DO UPDATE SET
      segment_id = EXCLUDED.segment_id,
      end_ms = EXCLUDED.end_ms,
      source_text = EXCLUDED.source_text,
      source = EXCLUDED.source,
      is_complete = pxh_transcript_cache.is_complete OR EXCLUDED.is_complete,
      updated_at = now()
  `, [context.videoId, context.sourceLanguage, source, complete, JSON.stringify(payload.map((item) => ({
    segment_key: item.segmentKey,
    segment_id: item.segmentId,
    start_ms: item.startMs,
    end_ms: item.endMs,
    source_text: item.sourceText,
  })))]);
}

export async function readTranslations(
  context: TranslationCacheContext,
  segments: Array<{ id: string; sourceText: string }>,
): Promise<Array<{ id: string; translatedText: string }>> {
  const sql = database();
  if (!sql || !segments.length) return [];
  await ensureSchema(sql);
  const requested = segments.map((segment) => ({ ...segment, hash: contentHash(segment.sourceText) }));
  const rows = await sql.query(`
    SELECT source_hash, translated_text
    FROM pxh_translation_cache
    WHERE video_id = $1 AND source_language = $2 AND target_language = $3
      AND source_hash = ANY($4::text[])
  `, [context.videoId, context.sourceLanguage, context.targetLanguage, requested.map((item) => item.hash)]) as Array<{
    source_hash: string; translated_text: string;
  }>;
  const byHash = new Map(rows.map((row) => [row.source_hash.trim(), row.translated_text]));
  return requested.flatMap((segment) => {
    const translatedText = byHash.get(segment.hash);
    return translatedText ? [{ id: segment.id, translatedText }] : [];
  });
}

export async function writeTranslations(
  context: TranslationCacheContext,
  segments: Array<{ sourceText: string; translatedText: string }>,
): Promise<void> {
  const sql = database();
  if (!sql || !segments.length) return;
  await ensureSchema(sql);
  const payload = segments.map((segment) => ({
    source_hash: contentHash(segment.sourceText),
    source_text: segment.sourceText,
    translated_text: segment.translatedText,
  }));
  await sql.query(`
    INSERT INTO pxh_translation_cache (
      video_id, source_language, target_language, source_hash, source_text, translated_text
    )
    SELECT $1, $2, $3, item.source_hash, item.source_text, item.translated_text
    FROM jsonb_to_recordset($4::jsonb) AS item(source_hash char(64), source_text text, translated_text text)
    ON CONFLICT (video_id, source_language, target_language, source_hash) DO UPDATE SET
      source_text = EXCLUDED.source_text,
      translated_text = EXCLUDED.translated_text,
      updated_at = now()
  `, [context.videoId, context.sourceLanguage, context.targetLanguage, JSON.stringify(payload)]);
}
