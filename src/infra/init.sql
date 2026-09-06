CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE OR REPLACE FUNCTION busca_texto(apelido VARCHAR, nome VARCHAR, stack VARCHAR[])
RETURNS TEXT AS $$
  SELECT apelido || ' ' || nome || ' ' || COALESCE(ARRAY_TO_STRING(stack, ' '), '')
$$ LANGUAGE SQL IMMUTABLE;

CREATE TABLE IF NOT EXISTS pessoas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  apelido VARCHAR(32) UNIQUE NOT NULL,
  nome VARCHAR(100) NOT NULL,
  nascimento DATE NOT NULL,
  stack VARCHAR(32)[],
  busca TEXT GENERATED ALWAYS AS (busca_texto(apelido, nome, stack)) STORED
);

CREATE INDEX IF NOT EXISTS idx_pessoas_busca ON pessoas USING GIN (busca gin_trgm_ops);
