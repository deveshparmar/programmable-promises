export interface ChecklistItem {
  id?: string;
  text: string;
  weight: number;
  required: boolean;
}

export interface PromiseView {
  id: string;
  payer_id: string;
  worker_email: string;
  title: string;
  description: string;
  amount_minor: number;
  currency: string;
  status: string;
  deadline_at: string;
  checklist_version: number;
  pass_threshold: number;
  status_detail: string | null;
  paypal_order_id: string | null;
  has_authorization: boolean;
  created_at: string;
  updated_at: string;
  checklist: ChecklistItem[];
  share_token?: string;
  worker_url?: string;
  checklist_error?: string;
}

export interface VerificationItem {
  checklist_item_id: string;
  text: string;
  passed: boolean;
  evidence: string;
  confidence: number;
}

export interface Verification {
  id: string;
  verdict: string;
  score: number | null;
  model: string;
  worker_feedback: string | null;
  created_at: string;
  items: VerificationItem[];
}

export interface ApiError {
  error?: { code?: string; message?: string };
}

export function money(minor: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(minor / 100);
}

export function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    DRAFT: "Draft",
    AWAITING_FUNDING: "Ready to fund",
    FUNDED: "Money held",
    SUBMITTED: "Photo received",
    VERIFYING: "Checking the photo",
    APPROVED: "Approved",
    REJECTED_RETRY: "Needs another photo",
    NEEDS_REVIEW: "Needs your decision",
    PAYING: "Capturing the hold",
    CAPTURED: "Captured, paying the worker",
    PAYMENT_FAILED: "Payout needs a retry",
    PAID: "Paid",
    EXPIRED_VOIDED: "Expired, hold released",
    CANCELLED: "Cancelled",
  };
  return labels[status] ?? status;
}

export function pillClass(status: string): string {
  if (["PAYMENT_FAILED", "CANCELLED", "EXPIRED_VOIDED", "REJECTED_RETRY"].includes(status)) return "pill bad";
  if (["NEEDS_REVIEW", "VERIFYING", "PAYING", "DRAFT", "AWAITING_FUNDING"].includes(status)) return "pill warn";
  return "pill";
}

export function toMinor(value: string): number | null {
  if (!/^\d+(\.\d{1,2})?$/.test(value.trim())) return null;
  const [dollars, cents = ""] = value.trim().split(".");
  return Number(dollars) * 100 + Number(cents.padEnd(2, "0"));
}

export function localDateInput(date: Date): string {
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
