import { canTransition, EXPIRY_VOID_STATUSES, TERMINAL_MONEY_STATUSES } from "@pp/shared";
import { kafkaEnabled } from "../config.js";
import { pool, withTx, type DbClient } from "../db.js";
import { HttpError } from "../errors.js";
import { publishPaymentCommand, publishWebhookReceived } from "../kafka/publish.js";
import {
  findPromiseById,
  findPromiseByPaypalIds,
  listDue,
  patchPromise,
  transitionStatus,
  type PromiseRow,
} from "../repos/promises.js";
import { withLock } from "../redis.js";
import { publish } from "../sse.js";
import {
  approvableOrder,
  authorizeOrder,
  captureAuthorization,
  createOrder,
  payoutItemStatus,
  payoutWorker,
  voidAuthorization,
} from "../paypal/client.js";

async function emit(promise: PromiseRow): Promise<void> {
  await publish(promise.id, {
    type: "status",
    status: promise.status,
    detail: promise.status_detail,
    at: new Date().toISOString(),
  });
}

export async function createFundingOrder(promiseId: string, payerId: string): Promise<{ order_id: string }> {
  const promise = await owned(promiseId, payerId);
  if (promise.paypal_order_id && (promise.status === "AWAITING_FUNDING" || promise.status === "FUNDED")) {
    const stillApprovable = promise.status === "FUNDED" || await approvableOrder(promise.paypal_order_id).catch(() => false);
    if (stillApprovable) return { order_id: promise.paypal_order_id };
  }
  if (promise.status !== "AWAITING_FUNDING") {
    throw new HttpError(409, "STATE_CONFLICT", "Confirm the checklist before funding.");
  }
  assertOpen(promise);
  const orderId = await createOrder(promise.id, promise.amount_minor);
  await withTx(async (client) => {
    await patchPromise(client, promise.id, { paypal_order_id: orderId });
  });
  return { order_id: orderId };
}

export async function confirmFunding(promiseId: string, payerId: string): Promise<PromiseRow> {
  const promise = await owned(promiseId, payerId);
  if (promise.status === "FUNDED") return promise;
  if (promise.status !== "AWAITING_FUNDING" || !promise.paypal_order_id) {
    throw new HttpError(409, "STATE_CONFLICT", "Create a PayPal order before confirming.");
  }
  assertOpen(promise);
  const authorizationId = await authorizeOrder(promise.paypal_order_id, promise.id);
  try {
    const updated = await withTx(async (client) => {
      await patchPromise(client, promise.id, { paypal_authorization_id: authorizationId, status_detail: null });
      return transitionStatus(client, promise.id, "AWAITING_FUNDING", "FUNDED", null);
    });
    await emit(updated);
    return updated;
  } catch (error) {
    if (error instanceof HttpError && error.code === "STATE_CONFLICT") {
      const current = await must(promise.id);
      if (current.status === "FUNDED") return current;
    }
    throw error;
  }
}

export async function settle(promiseId: string): Promise<PromiseRow> {
  const locked = await withLock(`lock:pay:${promiseId}`, 60_000, () => settleUnlocked(promiseId));
  if (!locked) throw new HttpError(409, "PAYMENT_IN_PROGRESS", "A payment is already running for this promise.");
  return locked;
}

async function settleUnlocked(promiseId: string): Promise<PromiseRow> {
  let promise = await must(promiseId);
  if (promise.deadline_at.getTime() <= Date.now() && promise.status === "APPROVED") {
    return expireOne(promise);
  }
  if (promise.status === "PAID") return promise;
  if (promise.status === "APPROVED" || promise.status === "PAYING") {
    promise = await capture(promise);
  }
  if (promise.status === "PAYMENT_FAILED") {
    promise = await withTx(async (client) => transitionStatus(client, promise.id, "PAYMENT_FAILED", "CAPTURED", null));
  }
  if (promise.status === "CAPTURED") {
    promise = await pay(promise);
  }
  return promise;
}

async function capture(promise: PromiseRow): Promise<PromiseRow> {
  const authorizationId = promise.paypal_authorization_id;
  if (!authorizationId) {
    throw new HttpError(409, "MISSING_AUTHORIZATION", "This promise has no PayPal authorization to capture.");
  }
  if (promise.status === "APPROVED") {
    promise = await withTx(async (client) => transitionStatus(client, promise.id, "APPROVED", "PAYING", null));
    await emit(promise);
  }
  try {
    const captureId = promise.paypal_capture_id ?? (await captureAuthorization(
      authorizationId,
      promise.id,
      promise.amount_minor,
    ));
    promise = await withTx(async (client) => {
      await patchPromise(client, promise.id, { paypal_capture_id: captureId });
      await poolEvent(client, promise.id, "api.capture", { capture_id: captureId });
      return transitionStatus(client, promise.id, "PAYING", "CAPTURED", null);
    });
    await emit(promise);
    return promise;
  } catch (error) {
    const message = error instanceof HttpError ? error.message : "Capture failed.";
    await withTx(async (client) => {
      await patchPromise(client, promise.id, { status_detail: message });
    });
    throw error;
  }
}

/** SUCCESS and UNCLAIMED both mean PayPal accepted the payout (sandbox often stays UNCLAIMED until claimed). */
const PAYOUT_PAID_STATUSES = new Set(["SUCCESS", "UNCLAIMED"]);
const PAYOUT_TERMINAL_FAIL = ["FAILED", "DENIED", "BLOCKED", "RETURNED", "REFUNDED", "CANCELED"];
/** Stay under Render's ~30s HTTP limit; background job rechecks every 30s. */
const PAYOUT_POLL_ATTEMPTS = 8;
const PAYOUT_POLL_DELAY_MS = 2000;

function payoutWaitingDetail(itemStatus: string): string {
  if (itemStatus === "UNCLAIMED") {
    return "PayPal sent the payout but it is unclaimed. Use a sandbox personal account email as the worker, or claim it in sandbox PayPal. The server rechecks automatically.";
  }
  if (itemStatus === "PENDING" || itemStatus === "ONHOLD") {
    return `PayPal payout is ${itemStatus}. Wait a moment, tap Retry payment, or let the server recheck (about every 30s).`;
  }
  return `PayPal payout status is ${itemStatus}. Tap Retry payment or fix the worker sandbox email.`;
}

function paidDetailForStatus(itemStatus: string): string | null {
  if (itemStatus === "UNCLAIMED") {
    return "Payout sent to the worker email (unclaimed in PayPal until they accept in sandbox).";
  }
  return null;
}

async function applyPayoutItemStatus(promise: PromiseRow, itemStatus: string): Promise<PromiseRow> {
  if (PAYOUT_PAID_STATUSES.has(itemStatus)) {
    const detail = paidDetailForStatus(itemStatus);
    const paid = await withTx(async (client) => transitionStatus(client, promise.id, "CAPTURED", "PAID", detail));
    await emit(paid);
    return paid;
  }
  if (PAYOUT_TERMINAL_FAIL.includes(itemStatus)) {
    const failed = await withTx(async (client) =>
      transitionStatus(client, promise.id, "CAPTURED", "PAYMENT_FAILED", `Payout item is ${itemStatus}.`),
    );
    await emit(failed);
    return failed;
  }
  await withTx(async (client) => {
    await patchPromise(client, promise.id, { status_detail: payoutWaitingDetail(itemStatus) });
  });
  return must(promise.id);
}

async function pollPayoutBatch(promise: PromiseRow, batchId: string): Promise<PromiseRow> {
  let itemStatus = "PENDING";
  for (let attempt = 0; attempt < PAYOUT_POLL_ATTEMPTS; attempt += 1) {
    itemStatus = await payoutItemStatus(batchId);
    if (PAYOUT_PAID_STATUSES.has(itemStatus) || PAYOUT_TERMINAL_FAIL.includes(itemStatus)) {
      return applyPayoutItemStatus(promise, itemStatus);
    }
    await new Promise((resolve) => setTimeout(resolve, PAYOUT_POLL_DELAY_MS));
  }
  return applyPayoutItemStatus(promise, itemStatus);
}

async function pay(promise: PromiseRow): Promise<PromiseRow> {
  let batchId = promise.paypal_payout_batch_id;
  if (!batchId) {
    try {
      const payoutKey = promise.paypal_capture_id ? `${promise.id}:${promise.paypal_capture_id}` : promise.id;
      batchId = await payoutWorker(promise.id, promise.worker_email, promise.amount_minor, payoutKey);
    } catch (error) {
      const detail = error instanceof HttpError ? error.message : "PayPal could not send the payout.";
      const failed = await withTx(async (client) =>
        transitionStatus(client, promise.id, "CAPTURED", "PAYMENT_FAILED", detail),
      );
      await emit(failed);
      return failed;
    }
    await withTx(async (client) => {
      await patchPromise(client, promise.id, { paypal_payout_batch_id: batchId });
      await poolEvent(client, promise.id, "api.payout", { payout_batch_id: batchId });
    });
  }
  return pollPayoutBatch(await must(promise.id), batchId);
}

/** Recheck CAPTURED promises on a timer (Render HTTP requests cannot poll PayPal for minutes). */
export async function pollPendingPayouts(): Promise<void> {
  const { rows } = await pool.query<PromiseRow>(
    `SELECT id, payer_id, worker_email, title, description, amount_minor, currency, status, deadline_at,
            share_token_hash, checklist_version, pending_challenge_code, paypal_order_id,
            paypal_authorization_id, paypal_capture_id, paypal_payout_batch_id, pass_threshold, status_detail,
            created_at, updated_at
     FROM promises
     WHERE status = 'CAPTURED' AND paypal_payout_batch_id IS NOT NULL`,
  );
  for (const row of rows) {
    try {
      await withLock(`lock:pay:${row.id}`, 55_000, async () => {
        const promise = await must(row.id);
        if (promise.status !== "CAPTURED" || !promise.paypal_payout_batch_id) return;
        const itemStatus = await payoutItemStatus(promise.paypal_payout_batch_id);
        if (itemStatus === "PENDING" || itemStatus === "ONHOLD") {
          await withTx(async (client) => {
            await patchPromise(client, promise.id, { status_detail: payoutWaitingDetail(itemStatus) });
          });
          return;
        }
        await applyPayoutItemStatus(promise, itemStatus);
      });
    } catch (error) {
      console.error("Payout poll failed", row.id, error);
    }
  }
}

export async function cancelPromise(promiseId: string, payerId: string): Promise<PromiseRow> {
  const promise = await owned(promiseId, payerId);
  if (promise.status === "CANCELLED" || promise.status === "EXPIRED_VOIDED") return promise;
  if (promise.status === "AWAITING_FUNDING" || promise.status === "DRAFT") {
    const updated = await withTx(async (client) =>
      transitionStatus(client, promise.id, promise.status, "CANCELLED", "Cancelled before any hold."),
    );
    await emit(updated);
    return updated;
  }
  if (!canTransition(promise.status, "CANCELLED")) {
    throw new HttpError(409, "STATE_CONFLICT", "This promise can no longer be cancelled.");
  }
  await voidIfHeld(promise);
  const updated = await withTx(async (client) =>
    transitionStatus(client, promise.id, promise.status, "CANCELLED", "The hold was released."),
  );
  await emit(updated);
  return updated;
}

export async function requestSettle(promiseId: string): Promise<PromiseRow> {
  if (kafkaEnabled()) {
    await publishPaymentCommand({
      messageId: crypto.randomUUID(),
      promiseId,
      command: "settle",
    });
    return must(promiseId);
  }
  return settle(promiseId);
}

export async function expireDue(): Promise<void> {
  const due = await listDue(new Date());
  for (const promise of due) {
    try {
      if (kafkaEnabled()) {
        await publishPaymentCommand({
          messageId: crypto.randomUUID(),
          promiseId: promise.id,
          command: "expire",
        });
        continue;
      }
      await expireOneById(promise.id);
    } catch (error) {
      console.error("Expiry failed", promise.id, error);
    }
  }
}

export async function expireOneById(promiseId: string): Promise<void> {
  const promise = await findPromiseById(promiseId);
  if (!promise) return;
  if (promise.deadline_at.getTime() > Date.now()) return;
  if (promise.status === "AWAITING_FUNDING") {
    const updated = await withTx(async (client) =>
      transitionStatus(client, promise.id, "AWAITING_FUNDING", "CANCELLED", "The deadline passed before funding."),
    );
    await emit(updated);
    return;
  }
  if (EXPIRY_VOID_STATUSES.includes(promise.status)) await expireOne(promise);
}

async function expireOne(promise: PromiseRow): Promise<PromiseRow> {
  await voidIfHeld(promise);
  const from = promise.status;
  if (!canTransition(from, "EXPIRED_VOIDED")) return must(promise.id);
  const updated = await withTx(async (client) =>
    transitionStatus(client, promise.id, from, "EXPIRED_VOIDED", "The deadline passed and the hold was released."),
  );
  await emit(updated);
  return updated;
}

async function voidIfHeld(promise: PromiseRow): Promise<void> {
  if (!promise.paypal_authorization_id) return;
  if (TERMINAL_MONEY_STATUSES.includes(promise.status)) return;
  try {
    await voidAuthorization(promise.paypal_authorization_id, promise.id);
  } catch (error) {
    if (error instanceof HttpError && error.code === "PAYPAL_STATE") return;
    throw error;
  }
}

export async function recordWebhook(eventId: string, eventType: string, resource: Record<string, unknown>): Promise<void> {
  const ids = collectIds(resource);
  const promise = await findPromiseByPaypalIds(ids);
  const inserted = await pool.query(
    `INSERT INTO payment_events (promise_id, type, paypal_event_id, payload)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (paypal_event_id) DO NOTHING`,
    [promise?.id ?? null, eventType, eventId, JSON.stringify(resource)],
  );
  if (!inserted.rowCount) return;
  if (kafkaEnabled()) {
    await publishWebhookReceived({
      messageId: crypto.randomUUID(),
      eventId,
      eventType,
      resource,
      promiseId: promise?.id ?? null,
    });
    return;
  }
  if (promise) await applyWebhook(promise, eventType, resource);
}

export async function applyWebhookEvent(
  eventId: string,
  eventType: string,
  resource: Record<string, unknown>,
  promiseIdHint: string | null,
): Promise<void> {
  void eventId;
  let promise = promiseIdHint ? await findPromiseById(promiseIdHint) : undefined;
  if (!promise) {
    promise = await findPromiseByPaypalIds(collectIds(resource));
  }
  if (!promise) return;
  await applyWebhook(promise, eventType, resource);
}

async function applyWebhook(promise: PromiseRow, eventType: string, resource: Record<string, unknown>): Promise<void> {
  if (eventType === "PAYMENT.AUTHORIZATION.CREATED" && promise.status === "AWAITING_FUNDING") {
    const authorizationId = stringOf(resource.id);
    if (!authorizationId) return;
    const updated = await withTx(async (client) => {
      await patchPromise(client, promise.id, { paypal_authorization_id: authorizationId });
      return transitionStatus(client, promise.id, "AWAITING_FUNDING", "FUNDED", null);
    });
    await emit(updated);
    return;
  }
  if (eventType === "PAYMENT.CAPTURE.COMPLETED" && promise.status === "PAYING") {
    const captureId = stringOf(resource.id);
    const updated = await withTx(async (client) => {
      if (captureId) await patchPromise(client, promise.id, { paypal_capture_id: captureId });
      return transitionStatus(client, promise.id, "PAYING", "CAPTURED", null);
    });
    await emit(updated);
    if (!updated.paypal_payout_batch_id) await settle(updated.id);
    return;
  }
  if ((eventType === "PAYMENT.CAPTURE.DENIED" || eventType === "PAYMENT.CAPTURE.PENDING") && promise.status === "PAYING") {
    await withTx(async (client) => {
      await patchPromise(client, promise.id, { status_detail: `PayPal capture is ${eventType}.` });
    });
    await emit(await must(promise.id));
    return;
  }
  if (eventType === "PAYMENT.AUTHORIZATION.VOIDED" && canTransition(promise.status, "CANCELLED")) {
    const updated = await withTx(async (client) =>
      transitionStatus(client, promise.id, promise.status, "CANCELLED", "PayPal voided the authorization."),
    );
    await emit(updated);
    return;
  }
  if (eventType === "PAYMENT.PAYOUTS-ITEM.SUCCEEDED") {
    await markPaid(promise.id);
    return;
  }
  if (
    ["PAYMENT.PAYOUTS-ITEM.FAILED", "PAYMENT.PAYOUTS-ITEM.DENIED", "PAYMENT.PAYOUTS-ITEM.BLOCKED", "PAYMENT.PAYOUTS-ITEM.RETURNED"].includes(eventType)
    && promise.status === "CAPTURED"
  ) {
    const updated = await withTx(async (client) =>
      transitionStatus(client, promise.id, "CAPTURED", "PAYMENT_FAILED", eventType),
    );
    await emit(updated);
  }
}

async function markPaid(promiseId: string): Promise<void> {
  const promise = await must(promiseId);
  if (promise.status === "PAID") return;
  if (promise.status === "PAYMENT_FAILED") {
    await withTx(async (client) => transitionStatus(client, promise.id, "PAYMENT_FAILED", "CAPTURED", null));
  }
  const current = await must(promiseId);
  if (current.status !== "CAPTURED") return;
  const updated = await withTx(async (client) => transitionStatus(client, current.id, "CAPTURED", "PAID", null));
  await emit(updated);
}

function collectIds(resource: Record<string, unknown>): string[] {
  const payoutItem = resource.payout_item as { sender_item_id?: string } | undefined;
  const related = (resource.supplementary_data as { related_ids?: Record<string, string> } | undefined)?.related_ids;
  return [
    stringOf(resource.id),
    stringOf(resource.custom_id),
    stringOf(resource.invoice_id),
    stringOf(resource.payout_batch_id),
    payoutItem?.sender_item_id,
    related?.order_id,
    related?.authorization_id,
    related?.capture_id,
  ].filter((id): id is string => Boolean(id));
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

async function poolEvent(client: DbClient, promiseId: string, type: string, payload: unknown): Promise<void> {
  await client.query(
    "INSERT INTO payment_events (promise_id, type, payload) VALUES ($1, $2, $3::jsonb)",
    [promiseId, type, JSON.stringify(payload)],
  );
}

async function owned(promiseId: string, payerId: string): Promise<PromiseRow> {
  const promise = await must(promiseId);
  if (promise.payer_id !== payerId) throw new HttpError(404, "NOT_FOUND", "Promise not found.");
  return promise;
}

async function must(id: string): Promise<PromiseRow> {
  const promise = await findPromiseById(id);
  if (!promise) throw new HttpError(404, "NOT_FOUND", "Promise not found.");
  return promise;
}

function assertOpen(promise: PromiseRow): void {
  if (promise.deadline_at.getTime() <= Date.now()) {
    throw new HttpError(409, "DEADLINE_PASSED", "The deadline has passed.");
  }
}
