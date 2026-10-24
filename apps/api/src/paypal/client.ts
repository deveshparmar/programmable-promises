import { config, paypalBaseUrl, paypalConfigured } from "../config.js";
import { HttpError } from "../errors.js";
import { minorToDecimal } from "../money.js";
import { redis } from "../redis.js";

interface PayPalErrorBody {
  message?: string;
  name?: string;
  details?: { issue?: string; description?: string }[];
}

async function paypalFetch(path: string, init: RequestInit, requestId?: string): Promise<Response> {
  if (!paypalConfigured()) {
    throw new HttpError(503, "PAYPAL_NOT_CONFIGURED", "Add PayPal sandbox credentials to the environment.");
  }
  const token = await accessToken();
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("Content-Type", "application/json");
  headers.set("Prefer", "return=representation");
  if (requestId) headers.set("PayPal-Request-Id", requestId);
  const response = await fetch(`${paypalBaseUrl}${path}`, { ...init, headers });
  return response;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { message: text.slice(0, 200) };
  }
}

function fail(response: Response, body: Record<string, unknown>): never {
  const details = body as PayPalErrorBody;
  console.error("PayPal error", response.status, JSON.stringify(details).slice(0, 1000));
  if (details.name === "PAYOUT_NOT_AVAILABLE") {
    throw new HttpError(
      502,
      "PAYOUT_NOT_AVAILABLE",
      "PayPal sandbox payouts are not allowed for this business account country. Create a United States sandbox business account with Payouts enabled.",
    );
  }
  const alreadyVoided = details.details?.some((detail) =>
    `${detail.issue ?? ""} ${detail.description ?? ""}`.toLowerCase().includes("already"),
  );
  if (alreadyVoided || response.status === 422) {
    throw new HttpError(409, "PAYPAL_STATE", "PayPal would not repeat that step. Refresh the promise and try again.");
  }
  const message = details.message?.trim();
  throw new HttpError(502, "PAYPAL_ERROR", message ? message.slice(0, 240) : "PayPal could not complete this step.");
}

export async function accessToken(): Promise<string> {
  const cached = await redis.get("paypal:access_token");
  if (cached) return cached;
  const secret = Buffer.from(`${config.paypalClientId}:${config.paypalClientSecret}`).toString("base64");
  const response = await fetch(`${paypalBaseUrl}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${secret}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const body = await readJson(response);
  if (!response.ok || typeof body.access_token !== "string") fail(response, body);
  const expiresIn = typeof body.expires_in === "number" ? body.expires_in : 300;
  const ttl = Math.max(30, expiresIn - 60);
  await redis.set("paypal:access_token", body.access_token, "EX", ttl);
  return body.access_token;
}

const ORDER_APPROVAL_MS = 2 * 60 * 60 * 1000;

export async function approvableOrder(orderId: string): Promise<boolean> {
  const response = await paypalFetch(`/v2/checkout/orders/${orderId}`, { method: "GET" });
  const body = await readJson(response);
  const units = body.purchase_units as { items?: unknown[] }[] | undefined;
  if (!response.ok || body.status !== "CREATED" || typeof body.create_time !== "string") return false;
  if (!units?.[0]?.items?.length) return false;
  const ageMs = Date.now() - Date.parse(body.create_time);
  return ageMs >= 0 && ageMs < ORDER_APPROVAL_MS;
}

export async function createOrder(promiseId: string, amountMinor: number): Promise<string> {
  const attempt = Date.now().toString();
  const value = minorToDecimal(amountMinor);
  const response = await paypalFetch("/v2/checkout/orders", {
    method: "POST",
    body: JSON.stringify({
      intent: "AUTHORIZE",
      application_context: {
        brand_name: "Programmable Promises",
        shipping_preference: "NO_SHIPPING",
        user_action: "CONTINUE",
      },
      purchase_units: [
        {
          custom_id: promiseId,
          invoice_id: `${promiseId}:${attempt}`,
          description: "Hold for a programmable promise",
          amount: {
            currency_code: "USD",
            value,
            breakdown: { item_total: { currency_code: "USD", value } },
          },
          items: [
            {
              name: "Promise hold",
              description: "The worker is paid only after the photo passes.",
              quantity: "1",
              category: "DIGITAL_GOODS",
              unit_amount: { currency_code: "USD", value },
            },
          ],
        },
      ],
    }),
  }, `${promiseId}:order:${attempt}`);
  const body = await readJson(response);
  if (!response.ok || typeof body.id !== "string") fail(response, body);
  return body.id;
}

export async function authorizeOrder(orderId: string, promiseId: string): Promise<string> {
  const response = await paypalFetch(
    `/v2/checkout/orders/${orderId}/authorize`,
    { method: "POST", body: "{}" },
    `${promiseId}:authorize`,
  );
  const body = await readJson(response);
  if (!response.ok) fail(response, body);
  const units = body.purchase_units as { payments?: { authorizations?: { id?: string }[] } }[] | undefined;
  const authorizationId = units?.[0]?.payments?.authorizations?.[0]?.id;
  if (!authorizationId) {
    console.error("PayPal authorize response missing id", JSON.stringify(body).slice(0, 1000));
    throw new HttpError(502, "PAYPAL_ERROR", "PayPal did not return an authorization.");
  }
  return authorizationId;
}

export async function captureAuthorization(authorizationId: string, promiseId: string, amountMinor: number): Promise<string> {
  const response = await paypalFetch(
    `/v2/payments/authorizations/${authorizationId}/capture`,
    {
      method: "POST",
      body: JSON.stringify({
        amount: { currency_code: "USD", value: minorToDecimal(amountMinor) },
        final_capture: true,
      }),
    },
    `${promiseId}:capture`,
  );
  const body = await readJson(response);
  if (!response.ok) fail(response, body);
  const status = typeof body.status === "string" ? body.status : "";
  if (status !== "COMPLETED" || typeof body.id !== "string") {
    throw new HttpError(409, "CAPTURE_NOT_COMPLETED", "PayPal has not completed the capture. The funds stay held.");
  }
  return body.id;
}

export async function payoutWorker(promiseId: string, workerEmail: string, amountMinor: number): Promise<string> {
  const response = await paypalFetch(
    "/v1/payments/payouts",
    {
      method: "POST",
      body: JSON.stringify({
        sender_batch_header: {
          sender_batch_id: promiseId,
          email_subject: "You were paid for a completed promise",
          email_message: "Programmable Promises released this payment because the work checked out.",
        },
        items: [
          {
            recipient_type: "EMAIL",
            amount: { value: minorToDecimal(amountMinor), currency: "USD" },
            receiver: workerEmail,
            sender_item_id: promiseId,
            note: "Payment for a completed promise",
          },
        ],
      }),
    },
    `${promiseId}:payout`,
  );
  const body = await readJson(response);
  if (!response.ok) fail(response, body);
  const header = body.batch_header as { payout_batch_id?: string } | undefined;
  if (!header?.payout_batch_id) {
    throw new HttpError(502, "PAYPAL_ERROR", "PayPal did not accept the payout.");
  }
  return header.payout_batch_id;
}

export async function payoutItemStatus(batchId: string): Promise<string> {
  const response = await paypalFetch(`/v1/payments/payouts/${batchId}`, { method: "GET" });
  const body = await readJson(response);
  if (!response.ok) fail(response, body);
  const items = body.items as { transaction_status?: string }[] | undefined;
  return items?.[0]?.transaction_status ?? "PENDING";
}

export async function voidAuthorization(authorizationId: string, promiseId: string): Promise<void> {
  const response = await paypalFetch(
    `/v2/payments/authorizations/${authorizationId}/void`,
    { method: "POST" },
    `${promiseId}:void`,
  );
  if (response.status === 204 || response.ok) return;
  const body = await readJson(response);
  const details = body as PayPalErrorBody;
  const already = details.details?.some((detail) =>
    `${detail.issue ?? ""} ${detail.description ?? ""}`.toLowerCase().includes("void"),
  );
  if (already) return;
  fail(response, body);
}

export async function verifyWebhook(headers: Record<string, string | undefined>, event: unknown): Promise<boolean> {
  if (!config.paypalWebhookId) return false;
  const response = await paypalFetch("/v1/notifications/verify-webhook-signature", {
    method: "POST",
    body: JSON.stringify({
      auth_algo: headers["paypal-auth-algo"],
      cert_url: headers["paypal-cert-url"],
      transmission_id: headers["paypal-transmission-id"],
      transmission_sig: headers["paypal-transmission-sig"],
      transmission_time: headers["paypal-transmission-time"],
      webhook_id: config.paypalWebhookId,
      webhook_event: event,
    }),
  });
  const body = await readJson(response);
  return response.ok && body.verification_status === "SUCCESS";
}
