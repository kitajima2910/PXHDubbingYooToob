ALTER TABLE pxh_dubbing.pxh_global_translation_memory
  ADD COLUMN IF NOT EXISTS canonical_hash char(64),
  ADD COLUMN IF NOT EXISTS canonical_text text,
  ADD COLUMN IF NOT EXISTS quality varchar(16) NOT NULL DEFAULT 'machine',
  ADD COLUMN IF NOT EXISTS usage_count bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_used_at timestamptz;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pxh_translation_quality_valid'
    AND conrelid = 'pxh_dubbing.pxh_global_translation_memory'::regclass) THEN
    ALTER TABLE pxh_dubbing.pxh_global_translation_memory
      ADD CONSTRAINT pxh_translation_quality_valid CHECK (quality IN ('machine', 'reviewed', 'gold'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS pxh_translation_memory_canonical
  ON pxh_dubbing.pxh_global_translation_memory (
    source_language, target_language, translation_version, canonical_hash
  );

-- Runtime backfills canonical_text/canonical_hash with the same TypeScript
-- canonicalizer used for lookups, avoiding differences between JS and SQL Unicode handling.
