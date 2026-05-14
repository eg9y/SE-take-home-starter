import express from "express";
import { trialsRouter } from "./routes/trials.js";

const app = express();
app.use(express.json());

app.use("/trials", trialsRouter);

app.get("/health", (_req, res) => {
	res.json({ status: "ok" });
});

const PORT = process.env["PORT"] ?? 3000;

app.listen(PORT, () => {
	console.log(`Server running on http://localhost:${PORT}`);
	if (!process.env["OPENAI_API_KEY"]) {
		console.warn("[warn] OPENAI_API_KEY is not set");
	}
});

export { app };
