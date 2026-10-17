import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { MAX_DEADLINE_MS } from "@pp/shared";
import { HttpError } from "./errors.js";

export function minorToDecimal(amountMinor: number): string {
  const dollars = Math.trunc(amountMinor / 100);
  const cents = Math.abs(amountMinor % 100).toString().padStart(2, "0");
  return `${dollars}.${cents}`;
}

export function assertDeadline(value: string): Date {
  const deadline = new Date(value);
  if (Number.isNaN(deadline.getTime())) {
    throw new HttpError(400, "INVALID_DEADLINE", "Deadline must be an ISO date.");
  }
  const delta = deadline.getTime() - Date.now();
  if (delta < 60_000) {
    throw new HttpError(400, "INVALID_DEADLINE", "Deadline must be at least a minute from now.");
  }
  if (delta > MAX_DEADLINE_MS) {
    throw new HttpError(400, "INVALID_DEADLINE", "Deadline must be within 48 hours so the hold stays inside PayPal's honor period.");
  }
  return deadline;
}

export function hashToken(token: string): string {
  return sha256(token);
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export function tokensMatch(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

const CHALLENGE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function newChallengeCode(): string {
  const bytes = randomBytes(4);
  return Array.from(bytes, (byte) => CHALLENGE_ALPHABET[byte % CHALLENGE_ALPHABET.length]).join("");
}
