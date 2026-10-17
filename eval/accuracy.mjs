import { readFile } from "node:fs/promises";

const labelsPath = new URL("./labels.json", import.meta.url);

try {
  const labels = JSON.parse(await readFile(labelsPath, "utf8"));
  const rows = Array.isArray(labels) ? labels : [];
  const scored = rows.filter((row) => row.expected && row.actual);
  const correct = scored.filter((row) => row.expected === row.actual).length;
  if (!scored.length) {
    console.log("No scored proofs in eval/labels.json. Accuracy is not claimed.");
    process.exit(0);
  }
  const accuracy = correct / scored.length;
  console.log(`Scored ${scored.length} proofs. Accuracy ${(accuracy * 100).toFixed(1)}%.`);
} catch (error) {
  if (error && error.code === "ENOENT") {
    console.log("No labeled proofs yet. Accuracy is not claimed.");
    process.exit(0);
  }
  throw error;
}
