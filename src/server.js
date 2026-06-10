import express from "express";
import { query } from "./infra/database.js";

const app = express();
const port = 3000;

app.get("/", (req, res) => {
  res.send("Hello World!");
});

// Prova de vida: roda um SELECT 1 contra o banco.
// Útil pra confirmar que pool + credenciais + rede estão ok.
app.get("/health", async (req, res) => {
  try {
    await query("SELECT 1");
    res.json({ ok: true });
  } catch (err) {
    res.status(503).json({ ok: false, error: err.message });
  }
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
