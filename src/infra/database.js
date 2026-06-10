// Conexão com o Postgres.
//
// Usamos um *pool* de conexões em vez de abrir/fechar conexão por requisição.
// Pool = um conjunto reutilizável de conexões TCP já abertas e prontas pra usar.
// Cada `query()` pega uma conexão livre, executa e devolve pro pool.
// Isso é essencial em APIs HTTP porque abrir conexão Postgres custa caro
// (handshake TCP + autenticação) — e bem mais que executar a query em si.

import pg from "pg";

const pool = new pg.Pool({
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER || "rinha",
  password: process.env.DB_PASSWORD || "rinha",
  database: process.env.DB_NAME || "rinha",
});

// Wrapper fino sobre pool.query().
// Exemplo de uso:  query("SELECT * FROM pessoas WHERE id = $1", [id])
// O `pg` faz prepared statement com $1, $2... — proteção contra SQL injection.
export function query(sql, params) {
  return pool.query(sql, params);
}
