import { kafkaProducer } from "./client.js";
import { TOPICS } from "./topics.js";

async function send(topic: string, key: string, value: unknown): Promise<void> {
  const producer = await kafkaProducer();
  await producer.send({
    topic,
    messages: [{ key, value: JSON.stringify(value) }],
  });
}

export interface WebhookMessage {
  messageId: string;
  eventId: string;
  eventType: string;
  resource: Record<string, unknown>;
  promiseId: string | null;
}

export interface ProofSubmittedMessage {
  messageId: string;
  promiseId: string;
  submissionId: string;
}

export interface VerificationCompletedMessage {
  messageId: string;
  promiseId: string;
  status: string;
}

export interface PaymentCommandMessage {
  messageId: string;
  promiseId: string;
  command: "settle" | "expire";
}

export async function publishWebhookReceived(body: WebhookMessage): Promise<void> {
  await send(TOPICS.paypalWebhook, body.eventId, body);
}

export async function publishProofSubmitted(body: ProofSubmittedMessage): Promise<void> {
  await send(TOPICS.proofSubmitted, body.promiseId, body);
}

export async function publishVerificationCompleted(body: VerificationCompletedMessage): Promise<void> {
  await send(TOPICS.verificationCompleted, body.promiseId, body);
}

export async function publishPaymentCommand(body: PaymentCommandMessage): Promise<void> {
  await send(TOPICS.paymentCommands, body.promiseId, body);
}

export async function publishPromiseEvent(promiseId: string, event: unknown): Promise<void> {
  await send(TOPICS.promiseEvents, promiseId, { promiseId, event, at: new Date().toISOString() });
}

export async function publishDlq(originalTopic: string, key: string, payload: unknown, error: string): Promise<void> {
  await send(TOPICS.dlq, key, { originalTopic, key, payload, error, at: new Date().toISOString() });
}
