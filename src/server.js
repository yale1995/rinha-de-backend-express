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

app.listen(3000, () => {
  console.log(`app is running`);
});
