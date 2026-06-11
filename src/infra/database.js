import { Client } from "pg";

export const client = new Client({
  host: "localhost",
  port: 5432,
  user: "rinha",
  database: "rinha",
  password: "rinha",
});

await client.connect();
