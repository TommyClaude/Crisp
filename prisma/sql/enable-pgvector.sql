-- Optional: enable pgvector-backed similarity search.
--
-- Run this against your database ONLY if the pgvector extension is available
-- (e.g. `apt install postgresql-16-pgvector`, or a managed Postgres like
-- Neon/Supabase/RDS with pgvector enabled):
--
--   psql "$DATABASE_URL" -f prisma/sql/enable-pgvector.sql
--
-- The app detects the column at runtime. Without it, RAG search falls back to
-- JSON-stored embeddings (cosine in app code) or Postgres full-text search.

CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE "EmbeddingChunk"
  ADD COLUMN IF NOT EXISTS embedding vector(1536);

-- IVFFlat index for fast approximate nearest-neighbour search once you have a
-- meaningful number of rows. Safe to run on an empty table.
CREATE INDEX IF NOT EXISTS embedding_chunk_embedding_idx
  ON "EmbeddingChunk"
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);
