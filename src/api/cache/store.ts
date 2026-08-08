import { createHash } from "node:crypto";
import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import type { SubtitleSegment } from "../../shared/types.js";

export interface CacheContext {
  videoId: string;
  sourceLanguage: string;
}

export interface TranslationCacheContext {
  sourceLanguage: string;
  targetLanguage: string;
}

let transcriptSchemaReady: Promise<void> | undefined;
let translationSchemaReady: Promise<void> | undefined;

function transcriptDatabaseUrl(): string | undefined {
  return process.env.DATABASE_URL?.trim() || process.env.NEON_DATABASE_URL?.trim() || undefined;
}

function translationDatabaseUrl(): string | undefined {
  return process.env.DUBBING_DATABASE_URL?.trim() || transcriptDatabaseUrl();
}

function database(url: string | undefined): NeonQueryFunction<false, false> | undefined {
  return url ? neon(url) : undefined;
}

export function cacheConfigured(): boolean {
  return Boolean(transcriptDatabaseUrl() || translationDatabaseUrl());
}

export function transcriptCacheConfigured(): boolean { return Boolean(transcriptDatabaseUrl()); }
export function translationCacheConfigured(): boolean { return Boolean(translationDatabaseUrl()); }

function translationVersion(): string { return process.env.TRANSLATION_CACHE_VERSION?.trim() || "v1"; }

export type TranslationQuality = "machine" | "reviewed" | "gold";

export function canonicalizeTranslationSource(text: string): string {
  const normalized = text.normalize("NFKC")
    .replace(/[‘’]/g, "'")
    .replace(/[“”„]/g, '"')
    .replace(/[‐‑‒–—]/g, "-")
    .toLocaleLowerCase("en-US")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;!?])/g, "$1")
    .trim();
  return normalized.replace(/[.!?,;:]+$/g, "") || normalized;
}

export function contentHash(text: string): string {
  return createHash("sha256").update(text.replace(/\s+/g, " ").trim(), "utf8").digest("hex");
}

async function ensureTranscriptSchema(sql: NeonQueryFunction<false, false>): Promise<void> {
  transcriptSchemaReady ??= (async () => {
    await sql.query("CREATE SCHEMA IF NOT EXISTS pxh_dubbing");
    await sql.query(`
      CREATE TABLE IF NOT EXISTS pxh_dubbing.pxh_transcript_cache (
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
      ON pxh_dubbing.pxh_transcript_cache (video_id, source_language, start_ms)
    `);
    await sql.query(`
      CREATE TABLE IF NOT EXISTS pxh_dubbing.pxh_transcript_window_cache (
        video_id varchar(11) NOT NULL,
        source_language varchar(16) NOT NULL,
        start_ms bigint NOT NULL,
        end_ms bigint NOT NULL,
        source varchar(80) NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (video_id, source_language, start_ms, end_ms)
      )
    `);
  })().catch((error) => { transcriptSchemaReady = undefined; throw error; });
  await transcriptSchemaReady;
}

async function ensureTranslationSchema(sql: NeonQueryFunction<false, false>): Promise<void> {
  translationSchemaReady ??= (async () => {
    await sql.query("CREATE SCHEMA IF NOT EXISTS pxh_dubbing");
    await sql.query(`
      CREATE TABLE IF NOT EXISTS pxh_dubbing.pxh_global_translation_memory (
        source_language varchar(16) NOT NULL,
        target_language varchar(16) NOT NULL,
        translation_version varchar(32) NOT NULL,
        source_hash char(64) NOT NULL,
        canonical_hash char(64),
        canonical_text text,
        source_text text NOT NULL,
        translated_text text NOT NULL,
        quality varchar(16) NOT NULL DEFAULT 'machine',
        usage_count bigint NOT NULL DEFAULT 0,
        last_used_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (source_language, target_language, translation_version, source_hash)
      )
    `);
    await sql.query("ALTER TABLE pxh_dubbing.pxh_global_translation_memory ADD COLUMN IF NOT EXISTS canonical_hash char(64)");
    await sql.query("ALTER TABLE pxh_dubbing.pxh_global_translation_memory ADD COLUMN IF NOT EXISTS canonical_text text");
    await sql.query("ALTER TABLE pxh_dubbing.pxh_global_translation_memory ADD COLUMN IF NOT EXISTS quality varchar(16) NOT NULL DEFAULT 'machine'");
    await sql.query("ALTER TABLE pxh_dubbing.pxh_global_translation_memory ADD COLUMN IF NOT EXISTS usage_count bigint NOT NULL DEFAULT 0");
    await sql.query("ALTER TABLE pxh_dubbing.pxh_global_translation_memory ADD COLUMN IF NOT EXISTS last_used_at timestamptz");
    await sql.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pxh_translation_quality_valid'
        AND conrelid = 'pxh_dubbing.pxh_global_translation_memory'::regclass) THEN
        ALTER TABLE pxh_dubbing.pxh_global_translation_memory
          ADD CONSTRAINT pxh_translation_quality_valid CHECK (quality IN ('machine', 'reviewed', 'gold'));
      END IF;
    END $$`);
    const missingCanonical = await sql.query(`
      SELECT source_language, target_language, translation_version, source_hash, source_text
      FROM pxh_dubbing.pxh_global_translation_memory WHERE canonical_hash IS NULL OR canonical_text IS NULL
    `) as Array<{ source_language: string; target_language: string; translation_version: string; source_hash: string; source_text: string }>;
    if (missingCanonical.length) {
      const payload = missingCanonical.map((row) => {
        const canonicalText = canonicalizeTranslationSource(row.source_text);
        return { ...row, canonical_text: canonicalText, canonical_hash: contentHash(canonicalText) };
      });
      await sql.query(`
        UPDATE pxh_dubbing.pxh_global_translation_memory AS memory SET
          canonical_text = item.canonical_text, canonical_hash = item.canonical_hash
        FROM jsonb_to_recordset($1::jsonb) AS item(
          source_language varchar(16), target_language varchar(16), translation_version varchar(32),
          source_hash char(64), canonical_text text, canonical_hash char(64)
        )
        WHERE memory.source_language = item.source_language AND memory.target_language = item.target_language
          AND memory.translation_version = item.translation_version AND memory.source_hash = item.source_hash
      `, [JSON.stringify(payload)]);
    }
    await sql.query(`CREATE INDEX IF NOT EXISTS pxh_translation_memory_canonical
      ON pxh_dubbing.pxh_global_translation_memory (source_language, target_language, translation_version, canonical_hash)`);
  })().catch((error) => { translationSchemaReady = undefined; throw error; });
  await translationSchemaReady;
}

export async function readTranscript(
  context: CacheContext,
  fromMs?: number,
  toMs?: number,
): Promise<{ segments: SubtitleSegment[]; source?: string; complete: boolean; covered?: boolean }> {
  const sql = database(transcriptDatabaseUrl());
  if (!sql) return { segments: [], complete: false };
  await ensureTranscriptSchema(sql);
  const rows = await sql.query(`
    SELECT segment_id, start_ms, end_ms, source_text, source, is_complete
    FROM pxh_dubbing.pxh_transcript_cache
    WHERE video_id = $1 AND source_language = $2
      AND ($3::bigint IS NULL OR end_ms >= $3)
      AND ($4::bigint IS NULL OR start_ms <= $4)
    ORDER BY start_ms, segment_key
  `, [context.videoId, context.sourceLanguage, fromMs ?? null, toMs ?? null]) as Array<{
    segment_id: string; start_ms: string | number; end_ms: string | number; source_text: string; source: string; is_complete: boolean;
  }>;
  const source = rows[0]?.source;
  let covered: boolean | undefined;
  if (fromMs !== undefined && toMs !== undefined) {
    const windows = await sql.query(`
      SELECT 1 FROM pxh_dubbing.pxh_transcript_window_cache
      WHERE video_id = $1 AND source_language = $2 AND start_ms <= $3 AND end_ms >= $4
      LIMIT 1
    `, [context.videoId, context.sourceLanguage, fromMs, toMs]);
    covered = windows.length > 0;
  }
  return {
    segments: rows.map((row) => ({
      id: row.segment_id,
      startMs: Number(row.start_ms),
      endMs: Number(row.end_ms),
      sourceText: row.source_text,
    })),
    ...(source ? { source } : {}),
    complete: rows.some((row) => row.is_complete),
    ...(covered === undefined ? {} : { covered }),
  };
}

export async function writeTranscript(
  context: CacheContext,
  source: string,
  segments: SubtitleSegment[],
  complete: boolean,
  window?: { fromMs: number; toMs: number },
): Promise<void> {
  const sql = database(transcriptDatabaseUrl());
  if (!sql || (!segments.length && !window)) return;
  await ensureTranscriptSchema(sql);
  if (complete) {
    await sql.query("DELETE FROM pxh_dubbing.pxh_transcript_cache WHERE video_id = $1 AND source_language = $2", [context.videoId, context.sourceLanguage]);
    await sql.query("DELETE FROM pxh_dubbing.pxh_transcript_window_cache WHERE video_id = $1 AND source_language = $2", [context.videoId, context.sourceLanguage]);
  }
  const payload = segments.map((segment) => ({
    segmentKey: contentHash(`${segment.startMs}:${segment.sourceText}`),
    segmentId: segment.id,
    startMs: Math.round(segment.startMs),
    endMs: Math.round(segment.endMs),
    sourceText: segment.sourceText,
  }));
  await sql.query(`
    INSERT INTO pxh_dubbing.pxh_transcript_cache AS cache (
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
      is_complete = cache.is_complete OR EXCLUDED.is_complete,
      updated_at = now()
  `, [context.videoId, context.sourceLanguage, source, complete, JSON.stringify(payload.map((item) => ({
    segment_key: item.segmentKey,
    segment_id: item.segmentId,
    start_ms: item.startMs,
    end_ms: item.endMs,
    source_text: item.sourceText,
  })))]);
  if (window) {
    await sql.query(`
      INSERT INTO pxh_dubbing.pxh_transcript_window_cache (video_id, source_language, start_ms, end_ms, source)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (video_id, source_language, start_ms, end_ms) DO UPDATE SET source = EXCLUDED.source, updated_at = now()
    `, [context.videoId, context.sourceLanguage, Math.round(window.fromMs), Math.round(window.toMs), source]);
  }
}

export async function readTranslations(
  context: TranslationCacheContext,
  segments: Array<{ id: string; sourceText: string }>,
): Promise<Array<{ id: string; translatedText: string }>> {
  const sql = database(translationDatabaseUrl());
  if (!sql || !segments.length) return [];
  await ensureTranslationSchema(sql);
  const requested = segments.map((segment) => {
    const canonicalText = canonicalizeTranslationSource(segment.sourceText);
    return { ...segment, hash: contentHash(segment.sourceText), canonicalHash: contentHash(canonicalText) };
  });
  const rows = await sql.query(`
    SELECT source_hash, canonical_hash, translated_text, quality, updated_at
    FROM pxh_dubbing.pxh_global_translation_memory
    WHERE source_language = $1 AND target_language = $2 AND translation_version = $3
      AND (source_hash = ANY($4::text[]) OR canonical_hash = ANY($5::text[]))
  `, [context.sourceLanguage, context.targetLanguage, translationVersion(), requested.map((item) => item.hash), requested.map((item) => item.canonicalHash)]) as Array<{
    source_hash: string; canonical_hash: string | null; translated_text: string; quality: TranslationQuality; updated_at: string;
  }>;
  const qualityRank: Record<TranslationQuality, number> = { machine: 1, reviewed: 2, gold: 3 };
  const choose = (current: typeof rows[number] | undefined, candidate: typeof rows[number]): typeof rows[number] => {
    if (!current) return candidate;
    const qualityDifference = qualityRank[candidate.quality] - qualityRank[current.quality];
    if (qualityDifference !== 0) return qualityDifference > 0 ? candidate : current;
    return new Date(candidate.updated_at).getTime() > new Date(current.updated_at).getTime() ? candidate : current;
  };
  const exact = new Map<string, typeof rows[number]>();
  const canonical = new Map<string, typeof rows[number]>();
  for (const row of rows) {
    const sourceHash = row.source_hash.trim();
    exact.set(sourceHash, choose(exact.get(sourceHash), row));
    const canonicalHash = row.canonical_hash?.trim();
    if (canonicalHash) canonical.set(canonicalHash, choose(canonical.get(canonicalHash), row));
  }
  const usedHashes = new Set<string>();
  const result = requested.flatMap((segment) => {
    const exactMatch = exact.get(segment.hash);
    const canonicalMatch = canonical.get(segment.canonicalHash);
    const match = exactMatch && canonicalMatch
      ? choose(canonicalMatch, exactMatch)
      : exactMatch ?? canonicalMatch;
    if (!match) return [];
    usedHashes.add(match.source_hash.trim());
    return [{ id: segment.id, translatedText: match.translated_text }];
  });
  if (usedHashes.size) {
    await sql.query(`
      UPDATE pxh_dubbing.pxh_global_translation_memory SET usage_count = usage_count + 1, last_used_at = now()
      WHERE source_language = $1 AND target_language = $2 AND translation_version = $3 AND source_hash = ANY($4::text[])
    `, [context.sourceLanguage, context.targetLanguage, translationVersion(), [...usedHashes]]);
  }
  return result;
}

export async function writeTranslations(
  context: TranslationCacheContext,
  segments: Array<{ sourceText: string; translatedText: string }>,
): Promise<void> {
  const sql = database(translationDatabaseUrl());
  if (!sql || !segments.length) return;
  await ensureTranslationSchema(sql);
  const payload = segments.map((segment) => {
    const canonicalText = canonicalizeTranslationSource(segment.sourceText);
    return {
      source_hash: contentHash(segment.sourceText), canonical_hash: contentHash(canonicalText), canonical_text: canonicalText,
      source_text: segment.sourceText, translated_text: segment.translatedText,
    };
  });
  await sql.query(`
    INSERT INTO pxh_dubbing.pxh_global_translation_memory (
      source_language, target_language, translation_version, source_hash, canonical_hash, canonical_text, source_text, translated_text
    )
    SELECT $1, $2, $3, item.source_hash, item.canonical_hash, item.canonical_text, item.source_text, item.translated_text
    FROM jsonb_to_recordset($4::jsonb) AS item(
      source_hash char(64), canonical_hash char(64), canonical_text text, source_text text, translated_text text
    )
    ON CONFLICT (source_language, target_language, translation_version, source_hash) DO UPDATE SET
      canonical_hash = EXCLUDED.canonical_hash,
      canonical_text = EXCLUDED.canonical_text,
      source_text = CASE WHEN pxh_global_translation_memory.quality = 'gold' THEN pxh_global_translation_memory.source_text ELSE EXCLUDED.source_text END,
      translated_text = CASE WHEN pxh_global_translation_memory.quality = 'gold' THEN pxh_global_translation_memory.translated_text ELSE EXCLUDED.translated_text END,
      updated_at = now()
  `, [context.sourceLanguage, context.targetLanguage, translationVersion(), JSON.stringify(payload)]);
}

export async function reviewTranslations(
  context: TranslationCacheContext,
  segments: Array<{ sourceText: string; translatedText: string }>,
): Promise<void> {
  const sql = database(translationDatabaseUrl());
  if (!sql || !segments.length) return;
  await ensureTranslationSchema(sql);
  const payload = segments.map((segment) => {
    const canonicalText = canonicalizeTranslationSource(segment.sourceText);
    return {
      source_hash: contentHash(segment.sourceText), canonical_hash: contentHash(canonicalText), canonical_text: canonicalText,
      source_text: segment.sourceText, translated_text: segment.translatedText,
    };
  });
  await sql.query(`
    INSERT INTO pxh_dubbing.pxh_global_translation_memory (
      source_language, target_language, translation_version, source_hash, canonical_hash, canonical_text, source_text, translated_text, quality
    )
    SELECT $1, $2, $3, item.source_hash, item.canonical_hash, item.canonical_text, item.source_text, item.translated_text, 'reviewed'
    FROM jsonb_to_recordset($4::jsonb) AS item(
      source_hash char(64), canonical_hash char(64), canonical_text text, source_text text, translated_text text
    )
    ON CONFLICT (source_language, target_language, translation_version, source_hash) DO UPDATE SET
      canonical_hash = EXCLUDED.canonical_hash,
      canonical_text = EXCLUDED.canonical_text,
      source_text = CASE WHEN pxh_global_translation_memory.quality = 'gold' THEN pxh_global_translation_memory.source_text ELSE EXCLUDED.source_text END,
      translated_text = CASE WHEN pxh_global_translation_memory.quality = 'gold' THEN pxh_global_translation_memory.translated_text ELSE EXCLUDED.translated_text END,
      quality = CASE WHEN pxh_global_translation_memory.quality = 'gold' THEN 'gold' ELSE 'reviewed' END,
      updated_at = now()
  `, [context.sourceLanguage, context.targetLanguage, translationVersion(), JSON.stringify(payload)]);
}
