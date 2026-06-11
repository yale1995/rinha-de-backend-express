import express from "express";
import { client } from "./infra/database.js";

const app = express();
app.use(express.json());

app.post("/pessoas", async (request, response) => {
  const { apelido, nome, nascimento, stack } = request.body;

  const result = await client.query(
    "INSERT INTO pessoas (apelido, nome, nascimento, stack) VALUES ($1, $2, $3, $4) RETURNING id",
    [apelido, nome, nascimento, stack]
  );

  const { id } = result.rows[0];

  response.setHeader("Location", `/pessoas/${id}`);
  return response.status(201).send();
});

app.get("/pessoas/:id", async (request, response) => {
  const { id } = request.params;

  const result = await client.query(
    "SELECT id, apelido, nome, nascimento, stack FROM pessoas WHERE id = $1",
    [id]
  );

  if (result.rows.length === 0) {
    return response.status(404).send();
  }

  return response.status(200).json(result.rows[0]);
});

app.listen(3000, () => {
  console.log(`app is running`);
});
