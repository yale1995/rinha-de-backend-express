-- Schema da tabela `pessoas`.
--
-- Regras vindas das instruções da Rinha:
--   apelido    -> obrigatório, ÚNICO, até 32 caracteres
--   nome       -> obrigatório, até 100 caracteres
--   nascimento -> obrigatório, data no formato AAAA-MM-DD
--   stack      -> opcional, lista de strings (cada uma até 32 caracteres)
--
-- Decisões:
--   - `id` é UUID gerado pelo PRÓPRIO Postgres via gen_random_uuid().
--     Built-in desde o Postgres 13 (sem precisar de CREATE EXTENSION).
--     Pra recuperar o id no INSERT, usar `RETURNING id`.
--   - `stack` é TEXT[] (array nativo do Postgres). Mais natural pra
--     "array de strings" do que JSONB, e permite buscar por elemento
--     com o operador `= ANY(stack)`.

CREATE TABLE IF NOT EXISTS pessoas (
  id         UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  apelido    VARCHAR(32)  NOT NULL UNIQUE,
  nome       VARCHAR(100) NOT NULL,
  nascimento DATE         NOT NULL,
  stack      TEXT[]
);
