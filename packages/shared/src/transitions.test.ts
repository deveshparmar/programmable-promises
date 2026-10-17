import assert from "node:assert/strict";
import test from "node:test";
import { canTransition, statusAfterVerdict } from "./transitions.js";

test("checklist confirm is the way out of draft", () => {
  assert.equal(canTransition("DRAFT", "AWAITING_FUNDING"), true);
  assert.equal(canTransition("DRAFT", "FUNDED"), false);
});

test("money moves only after approval", () => {
  assert.equal(canTransition("VERIFYING", "APPROVED"), true);
  assert.equal(canTransition("VERIFYING", "PAYING"), false);
  assert.equal(canTransition("APPROVED", "PAYING"), true);
  assert.equal(canTransition("PAYING", "CAPTURED"), true);
  assert.equal(canTransition("CAPTURED", "PAID"), true);
  assert.equal(canTransition("CAPTURED", "PAYMENT_FAILED"), true);
  assert.equal(canTransition("PAYMENT_FAILED", "CAPTURED"), true);
  assert.equal(canTransition("PAID", "PAYING"), false);
});

test("cancel is blocked once capture starts", () => {
  assert.equal(canTransition("APPROVED", "CANCELLED"), true);
  assert.equal(canTransition("PAYING", "CANCELLED"), false);
  assert.equal(canTransition("AWAITING_FUNDING", "CANCELLED"), true);
});

test("the third fail goes to a person, earlier fails can be retried", () => {
  assert.equal(statusAfterVerdict("fail", 1), "REJECTED_RETRY");
  assert.equal(statusAfterVerdict("fail", 2), "REJECTED_RETRY");
  assert.equal(statusAfterVerdict("fail", 3), "NEEDS_REVIEW");
});

test("pass, unsure, and verifier errors land on the expected statuses", () => {
  assert.equal(statusAfterVerdict("pass", 1), "APPROVED");
  assert.equal(statusAfterVerdict("unsure", 1), "NEEDS_REVIEW");
  assert.equal(statusAfterVerdict("error", 0), "NEEDS_REVIEW");
});
