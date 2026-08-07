CREATE SCHEMA IF NOT EXISTS pxh_dubbing;

CREATE TABLE IF NOT EXISTS pxh_dubbing.pxh_global_translation_memory (
  source_language varchar(16) NOT NULL,
  target_language varchar(16) NOT NULL,
  translation_version varchar(32) NOT NULL,
  source_hash char(64) NOT NULL,
  source_text text NOT NULL,
  translated_text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_language, target_language, translation_version, source_hash)
);
