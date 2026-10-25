export const TOPICS = {
  paypalWebhook: "paypal.webhook.received",
  proofSubmitted: "proof.submitted",
  verificationCompleted: "verification.completed",
  paymentCommands: "payment.commands",
  promiseEvents: "promise.events",
  dlq: "dlq.failed",
} as const;

export const ALL_TOPICS = Object.values(TOPICS);
