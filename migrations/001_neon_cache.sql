CREATE SCHEMA IF NOT EXISTS pxh_dubbing;

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
);

CREATE INDEX IF NOT EXISTS pxh_transcript_cache_timeline
ON pxh_dubbing.pxh_transcript_cache (video_id, source_language, start_ms);

CREATE TABLE IF NOT EXISTS pxh_dubbing.pxh_translation_cache (
  video_id varchar(11) NOT NULL,
  source_language varchar(16) NOT NULL,
  target_language varchar(16) NOT NULL,
  source_hash char(64) NOT NULL,
  source_text text NOT NULL,
  translated_text text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (video_id, source_language, target_language, source_hash)
);
