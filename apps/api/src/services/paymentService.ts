import { canTransition, EXPIRY_VOID_STATUSES, TERMINAL_MONEY_STATUSES } from "@pp/shared";
import { pool, withTx, type DbClient } from "../db.js";
import { HttpError } from "../errors.js";
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
    return { order_id: promise.paypal_order_id };
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

async function pay(promise: PromiseRow): Promise<PromiseRow> {
  const batchId = promise.paypal_payout_batch_id ?? (await payoutWorker(
    promise.id,
    promise.worker_email,
    promise.amount_minor,
  ));
  await withTx(async (client) => {
    await patchPromise(client, promise.id, { paypal_payout_batch_id: batchId });
    await poolEvent(client, promise.id, "api.payout", { payout_batch_id: batchId });
  });
  let itemStatus = "PENDING";
  for (let attempt = 0; attempt < 5; attempt += 1) {
    itemStatus = await payoutItemStatus(batchId);
    if (itemStatus === "SUCCESS") {
      const paid = await withTx(async (client) => transitionStatus(client, promise.id, "CAPTURED", "PAID", null));
      await emit(paid);
      return paid;
    }
    if (["FAILED", "DENIED", "BLOCKED", "RETURNED", "REFUNDED", "CANCELED"].includes(itemStatus)) break;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  if (itemStatus === "SUCCESS") return must(promise.id);
  if (["FAILED", "DENIED", "BLOCKED", "RETURNED", "REFUNDED", "CANCELED"].includes(itemStatus)) {
    const failed = await withTx(async (client) =>
      transitionStatus(client, promise.id, "CAPTURED", "PAYMENT_FAILED", `Payout item is ${itemStatus}.`),
    );
    await emit(failed);
    return failed;
  }
  const waiting = await must(promise.id);
  await withTx(async (client) => {
    await patchPromise(client, waiting.id, { status_detail: `Payout item is ${itemStatus}.` });
  });
  return must(promise.id);
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

export async function expireDue(): Promise<void> {
  const due = await listDue(new Date());
  for (const promise of due) {
    try {
      if (promise.status === "AWAITING_FUNDING") {
        const updated = await withTx(async (client) =>
          transitionStatus(client, promise.id, "AWAITING_FUNDING", "CANCELLED", "The deadline passed before funding."),
        );
        await emit(updated);
        continue;
      }
      if (EXPIRY_VOID_STATUSES.includes(promise.status)) await expireOne(promise);
    } catch (error) {
      console.error("Expiry failed", promise.id, error);
    }
  }
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
  if (!inserted.rowCount || !promise) return;
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
