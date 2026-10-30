import { pool } from "../db.js";

const STATUS_LABELS: Record<string, string> = {
  DRAFT: "Draft",
  AWAITING_FUNDING: "Awaiting funding",
  FUNDED: "Money held",
  SUBMITTED: "Submitted",
  VERIFYING: "Verifying",
  APPROVED: "Approved",
  PAYING: "Paying",
  CAPTURED: "Captured",
  PAID: "Paid",
  REJECTED_RETRY: "Retry proof",
  NEEDS_REVIEW: "Needs review",
  EXPIRED: "Expired",
  CANCELLED: "Cancelled",
  PAYMENT_FAILED: "Payment failed",
};

export interface StudioPromiseRow {
  promise_id: string;
  title: string;
  worker_email: string;
  status: string;
  status_label: string;
  amount_minor: number;
  amount_dollars: number;
  funded: string;
  needs_review: number;
  deadline_at: string;
  created_at: string;
  updated_at: string;
}

export interface StudioVerificationRow {
  promise_id: string;
  promise_title: string;
  verification_id: string;
  verdict: string;
  model: string;
  score: number | null;
  checklist_item: string;
  passed: string;
  confidence: number | null;
  created_at: string;
}

export async function getStudioData(payerId: string): Promise<{
  promises: StudioPromiseRow[];
  verification_items: StudioVerificationRow[];
}> {
  const promiseResult = await pool.query<{
    id: string;
    title: string;
    worker_email: string;
    status: string;
    amount_minor: number;
    paypal_authorization_id: string | null;
    deadline_at: Date;
    created_at: Date;
    updated_at: Date;
  }>(
    `SELECT id, title, worker_email, status, amount_minor, paypal_authorization_id, deadline_at, created_at, updated_at
     FROM promises
     WHERE payer_id = $1
     ORDER BY updated_at DESC`,
    [payerId],
  );

  const promises: StudioPromiseRow[] = promiseResult.rows.map((row) => ({
    promise_id: row.id,
    title: row.title,
    worker_email: row.worker_email,
    status: row.status,
    status_label: STATUS_LABELS[row.status] ?? row.status,
    amount_minor: row.amount_minor,
    amount_dollars: row.amount_minor / 100,
    funded: row.paypal_authorization_id ? "Yes" : "No",
    needs_review: row.status === "NEEDS_REVIEW" ? 1 : 0,
    deadline_at: row.deadline_at.toISOString(),
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  }));

  const verificationResult = await pool.query<{
    promise_id: string;
    promise_title: string;
    verification_id: string;
    verdict: string;
    model: string;
    score: number | null;
    checklist_item: string | null;
    passed: boolean | null;
    confidence: number | null;
    created_at: Date;
  }>(
    `SELECT p.id AS promise_id, p.title AS promise_title, v.id AS verification_id, v.verdict, v.model, v.score,
            c.text AS checklist_item, vi.passed, vi.confidence, v.created_at
     FROM promises p
     JOIN submissions s ON s.promise_id = p.id
     JOIN verifications v ON v.submission_id = s.id
     LEFT JOIN verification_items vi ON vi.verification_id = v.id
     LEFT JOIN checklist_items c ON c.id = vi.checklist_item_id
     WHERE p.payer_id = $1
     ORDER BY v.created_at DESC`,
    [payerId],
  );

  const verification_items: StudioVerificationRow[] = verificationResult.rows.map((row) => ({
    promise_id: row.promise_id,
    promise_title: row.promise_title,
    verification_id: row.verification_id,
    verdict: row.verdict,
    model: row.model,
    score: row.score === null ? null : Number(row.score),
    checklist_item: row.checklist_item ?? "",
    passed: row.passed === null ? "" : row.passed ? "Yes" : "No",
    confidence: row.confidence === null ? null : Number(row.confidence),
    created_at: new Date(row.created_at).toISOString(),
  }));

  return { promises, verification_items };
}
