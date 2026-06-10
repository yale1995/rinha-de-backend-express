import express from "express";

const app = express();
app.use(express.json());

app.post("/pessoas", async (request, response) => {
  const { body } = request;

  return response.json(request.body);
});

app.listen(3000, () => {
  console.log(`app is running`);
});
