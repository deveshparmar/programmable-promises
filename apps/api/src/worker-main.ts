import { migrate, waitForDatabase } from "./db.js";
import { kafkaEnabled } from "./config.js";
import { startWorkers } from "./workers/run.js";

async function main(): Promise<void> {
  if (!kafkaEnabled()) {
    console.error("Set KAFKA_BROKERS to run the worker process.");
    process.exit(1);
  }
  await waitForDatabase();
  await migrate();
  await startWorkers();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
