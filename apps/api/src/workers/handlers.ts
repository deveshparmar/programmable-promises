import { claimKafkaMessage } from "../kafka/inbox.js";
import { TOPICS } from "../kafka/topics.js";
import type { PaymentCommandMessage, ProofSubmittedMessage, VerificationCompletedMessage, WebhookMessage } from "../kafka/publish.js";
import { findPromiseById } from "../repos/promises.js";
import {
  applyWebhookEvent,
  expireOneById,
  settle,
} from "../services/paymentService.js";
import { runVerificationForSubmission } from "../services/verificationService.js";

export async function handleWebhookMessage(raw: WebhookMessage): Promise<void> {
  if (!(await claimKafkaMessage(raw.messageId, TOPICS.paypalWebhook))) return;
  await applyWebhookEvent(raw.eventId, raw.eventType, raw.resource, raw.promiseId);
}

export async function handleProofSubmitted(raw: ProofSubmittedMessage): Promise<void> {
  if (!(await claimKafkaMessage(raw.messageId, TOPICS.proofSubmitted))) return;
  const promise = await findPromiseById(raw.promiseId);
  if (!promise || promise.status !== "VERIFYING") return;
  await runVerificationForSubmission(raw.submissionId);
}

export async function handleVerificationCompleted(raw: VerificationCompletedMessage): Promise<void> {
  if (!(await claimKafkaMessage(raw.messageId, TOPICS.verificationCompleted))) return;
  if (raw.status !== "APPROVED") return;
  const promise = await findPromiseById(raw.promiseId);
  if (!promise) return;
  if (promise.status === "APPROVED" || promise.status === "PAYING" || promise.status === "CAPTURED") {
    await settle(raw.promiseId);
  }
}

export async function handlePaymentCommand(raw: PaymentCommandMessage): Promise<void> {
  if (!(await claimKafkaMessage(raw.messageId, TOPICS.paymentCommands))) return;
  if (raw.command === "settle") {
    await settle(raw.promiseId);
    return;
  }
  if (raw.command === "expire") {
    await expireOneById(raw.promiseId);
  }
}
