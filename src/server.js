import express from "express";
import { client } from "./infra/database.js";

const app = express();
app.use(express.json());

app.post("/pessoas", async (request, response) => {
  const { apelido, nome, nascimento, stack } = request.body;

  if (!nome || !apelido || !nascimento) {
    return response.status(422).end();
  }

  if (typeof nome !== "string" || typeof apelido !== "string") {
    return response.status(400).end();
  }

  if (stack && !Array.isArray(stack)) {
    return response.status(400).end();
  }

  if (Array.isArray(stack) && stack.some((item) => typeof item !== "string")) {
    return response.status(400).end();
  }

  if (typeof nascimento !== "string") {
    return response.status(400).end();
  }

  const parsedDate = new Date(nascimento);

  if (
    isNaN(parsedDate.getTime()) ||
    parsedDate.toISOString().slice(0, 10) !== nascimento
  ) {
    return response.status(422).end();
  }

  try {
    const result = await client.query(
      `
      INSERT INTO
        pessoas (
          apelido, nome, nascimento, stack)
        VALUES
          ($1, $2, $3, $4)
      RETURNING id
      `,
      [apelido, nome, nascimento, stack],
    );

    const { id } = result.rows[0];

    response.setHeader("Location", `/pessoas/${id}`);
    return response.status(201).send();
  } catch {
    return response.status(422).end();
  }
});

app.get("/pessoas/:id", async (request, response) => {
  const { id } = request.params;

  const result = await client.query(
    `
    SELECT 
      id, apelido, nome, to_char(nascimento, 'YYYY-MM-DD') as nascimento, stack
    FROM 
      pessoas 
    WHERE 
      id = $1
    `,
    [id],
  );

  if (result.rows.length === 0) {
    return response.status(404).send();
  }

  return response.status(200).json(result.rows[0]);
});

app.get("/pessoas", async (request, response) => {
  const { t } = request.query;

  if (!t) {
    return response.status(400).end();
  }

  const result = await client.query(
    `
    SELECT 
      id, apelido, nome, to_char(nascimento, 'YYYY-MM-DD') as nascimento, stack 
    FROM 
      pessoas 
    WHERE 
      nome ILIKE $1
    OR
      apelido ILIKE $1
    OR
      ARRAY_TO_STRING(stack, ',') ILIKE $1
    LIMIT 50
    `,
    [`%${t}%`],
  );

  return response.status(200).json(result.rows);
});

app.get("/contagem-pessoas", async (request, response) => {
  const result = await client.query(
    `
    SELECT COUNT 
      (*) 
    FROM 
      pessoas 
    `,
  );

  return response.status(200).send(result.rows[0].count);
});

app.listen(3000, () => {
  console.log(`app is running`);
});
