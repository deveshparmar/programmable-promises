import type { Consumer, EachMessagePayload } from "kafkajs";
import { kafkaConsumer, ensureKafkaTopics } from "../kafka/client.js";
import { publishDlq } from "../kafka/publish.js";
import { TOPICS } from "../kafka/topics.js";
import {
  handlePaymentCommand,
  handleProofSubmitted,
  handleVerificationCompleted,
  handleWebhookMessage,
} from "./handlers.js";
import type { PaymentCommandMessage, ProofSubmittedMessage, VerificationCompletedMessage, WebhookMessage } from "../kafka/publish.js";

const MAX_ATTEMPTS = 3;

async function withRetry(
  topic: string,
  key: string,
  payload: unknown,
  fn: () => Promise<void>,
): Promise<void> {
  let lastError = "unknown";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      await fn();
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      console.error(`Worker ${topic} attempt ${attempt} failed`, lastError);
      if (attempt < MAX_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }
  }
  await publishDlq(topic, key, payload, lastError);
}

function parseJson<T>(value: Buffer | null): T {
  if (!value) throw new Error("Empty Kafka message.");
  return JSON.parse(value.toString("utf8")) as T;
}

async function subscribe(consumer: Consumer, topic: string, handler: (payload: EachMessagePayload) => Promise<void>): Promise<void> {
  await consumer.subscribe({ topic, fromBeginning: false });
  await consumer.run({
    eachMessage: handler,
  });
}

export async function startWorkers(): Promise<void> {
  await ensureKafkaTopics();

  const verifier = await kafkaConsumer("pp-verifier");
  await subscribe(verifier, TOPICS.proofSubmitted, async ({ message }) => {
    const body = parseJson<ProofSubmittedMessage>(message.value);
    await withRetry(TOPICS.proofSubmitted, body.promiseId, body, () => handleProofSubmitted(body));
  });

  const payment = await kafkaConsumer("pp-payment");
  await payment.subscribe({ topics: [TOPICS.paypalWebhook, TOPICS.verificationCompleted, TOPICS.paymentCommands], fromBeginning: false });
  await payment.run({
    eachMessage: async ({ topic, message }) => {
      const key = message.key?.toString() ?? "";
      if (topic === TOPICS.paypalWebhook) {
        const body = parseJson<WebhookMessage>(message.value);
        await withRetry(topic, key, body, () => handleWebhookMessage(body));
        return;
      }
      if (topic === TOPICS.verificationCompleted) {
        const body = parseJson<VerificationCompletedMessage>(message.value);
        await withRetry(topic, key, body, () => handleVerificationCompleted(body));
        return;
      }
      if (topic === TOPICS.paymentCommands) {
        const body = parseJson<PaymentCommandMessage>(message.value);
        await withRetry(topic, key, body, () => handlePaymentCommand(body));
      }
    },
  });

  console.log("Kafka workers listening", [TOPICS.proofSubmitted, TOPICS.paypalWebhook, TOPICS.verificationCompleted, TOPICS.paymentCommands].join(", "));
}
