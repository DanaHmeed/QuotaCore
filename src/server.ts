import express from "express";

const app = express();

const PORT = 3000;

app.use(express.json());

app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    service: "QuotaCore"
  });
});

app.listen(PORT, () => {
  console.log(`QuotaCore running on port ${PORT}`);
});