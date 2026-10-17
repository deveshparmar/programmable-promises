export const STATUSES = [
  "DRAFT",
  "AWAITING_FUNDING",
  "FUNDED",
  "SUBMITTED",
  "VERIFYING",
  "APPROVED",
  "REJECTED_RETRY",
  "NEEDS_REVIEW",
  "PAYING",
  "CAPTURED",
  "PAYMENT_FAILED",
  "PAID",
  "EXPIRED_VOIDED",
  "CANCELLED",
] as const;

export type PromiseStatus = (typeof STATUSES)[number];

export const MAX_SCORED_FAILS = 3;
export const MIN_AMOUNT_MINOR = 100;
export const MAX_AMOUNT_MINOR = 1_000_000;
export const MAX_DEADLINE_MS = 48 * 60 * 60 * 1000;
export const PASS_THRESHOLD_DEFAULT = 0.8;
export const ITEM_CONFIDENCE_MIN = 0.7;

const TRANSITIONS: Record<PromiseStatus, readonly PromiseStatus[]> = {
  DRAFT: ["AWAITING_FUNDING", "CANCELLED"],
  AWAITING_FUNDING: ["FUNDED", "CANCELLED"],
  FUNDED: ["SUBMITTED", "CANCELLED", "EXPIRED_VOIDED"],
  SUBMITTED: ["VERIFYING", "CANCELLED", "EXPIRED_VOIDED"],
  VERIFYING: ["APPROVED", "REJECTED_RETRY", "NEEDS_REVIEW"],
  REJECTED_RETRY: ["SUBMITTED", "CANCELLED", "EXPIRED_VOIDED"],
  NEEDS_REVIEW: ["APPROVED", "CANCELLED", "EXPIRED_VOIDED"],
  APPROVED: ["PAYING", "CANCELLED", "EXPIRED_VOIDED"],
  PAYING: ["CAPTURED"],
  CAPTURED: ["PAID", "PAYMENT_FAILED"],
  PAYMENT_FAILED: ["CAPTURED"],
  PAID: [],
  EXPIRED_VOIDED: [],
  CANCELLED: [],
};

export function canTransition(from: PromiseStatus, to: PromiseStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export const UPLOAD_STATUSES: readonly PromiseStatus[] = ["FUNDED", "REJECTED_RETRY"];

export const VOID_CANCEL_STATUSES: readonly PromiseStatus[] = [
  "FUNDED",
  "SUBMITTED",
  "REJECTED_RETRY",
  "NEEDS_REVIEW",
  "APPROVED",
];

export const EXPIRY_VOID_STATUSES: readonly PromiseStatus[] = [
  "FUNDED",
  "SUBMITTED",
  "REJECTED_RETRY",
  "NEEDS_REVIEW",
];

export const TERMINAL_MONEY_STATUSES: readonly PromiseStatus[] = [
  "CAPTURED",
  "PAYMENT_FAILED",
  "PAID",
  "PAYING",
];

export type RulesVerdict = "pass" | "fail" | "unsure" | "error";

export function statusAfterVerdict(verdict: RulesVerdict, failCount: number): PromiseStatus {
  if (verdict === "pass") return "APPROVED";
  if (verdict === "fail") {
    return failCount >= MAX_SCORED_FAILS ? "NEEDS_REVIEW" : "REJECTED_RETRY";
  }
  return "NEEDS_REVIEW";
}
