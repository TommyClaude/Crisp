-- Full-text search indexes (kept outside the Prisma schema because Prisma
-- does not model expression indexes). The 'simple' configuration is used so
-- search works acceptably across languages.

CREATE INDEX "Message_content_fts_idx"
  ON "Message"
  USING GIN (to_tsvector('simple', coalesce(content, '')));

CREATE INDEX "EmbeddingChunk_chunkText_fts_idx"
  ON "EmbeddingChunk"
  USING GIN (to_tsvector('simple', "chunkText"));
