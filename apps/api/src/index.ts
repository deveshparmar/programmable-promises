import cors from "cors";
import express from "express";
import { ZodError } from "zod";
import { config, kafkaEnabled } from "./config.js";
import { ensureKafkaTopics } from "./kafka/client.js";
import { migrate, waitForDatabase } from "./db.js";
import { HttpError } from "./errors.js";
import { apiRouter } from "./routes.js";
import { expireDue, pollPendingPayouts } from "./services/paymentService.js";

const app = express();
app.use(
  cors({
    origin: true,
    allowedHeaders: ["Authorization", "Content-Type", "Idempotency-Key", "X-Share-Token"],
  }),
);
app.use(express.json({ limit: "1mb" }));

app.use("/api", apiRouter());

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const parseError = error as { status?: number; type?: string };
  if (parseError.status === 400 && parseError.type === "entity.parse.failed") {
    res.status(400).json({ error: { code: "INVALID_JSON", message: "Request body must be JSON." } });
    return;
  }
  if (error instanceof ZodError) {
    res.status(400).json({ error: { code: "INVALID_INPUT", message: error.issues[0]?.message ?? "Invalid input." } });
    return;
  }
  if (error instanceof HttpError) {
    res.status(error.status).json({ error: { code: error.code, message: error.message } });
    return;
  }
  const multerError = error as { code?: string };
  if (multerError?.code === "LIMIT_FILE_SIZE") {
    res.status(400).json({ error: { code: "UNSUPPORTED_FILE", message: "Upload one jpg or png, up to 10 MB." } });
    return;
  }
  console.error(error);
  res.status(500).json({ error: { code: "INTERNAL", message: "Something went wrong." } });
});

async function main(): Promise<void> {
  await waitForDatabase();
  await migrate();
  if (kafkaEnabled()) {
    await ensureKafkaTopics();
    console.log("Kafka producers enabled");
  }
  app.listen(config.port, () => {
    console.log(`API listening on ${config.port}`);
  });
  setInterval(() => {
    void expireDue();
    void pollPendingPayouts();
  }, 30_000).unref();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
