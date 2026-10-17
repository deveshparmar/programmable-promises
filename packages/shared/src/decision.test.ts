import assert from "node:assert/strict";
import test from "node:test";
import { decide } from "./decision.js";
import type { DecisionItem } from "./decision.js";

function item(partial: Partial<DecisionItem> & Pick<DecisionItem, "passed">): DecisionItem {
  return {
    checklistItemId: partial.checklistItemId ?? "11111111-1111-1111-1111-111111111111",
    passed: partial.passed,
    confidence: partial.confidence ?? 0.95,
    weight: partial.weight ?? 1,
    required: partial.required ?? true,
  };
}

const issued = "A7K2";

test("pass when required items, score, and challenge code all clear", () => {
  const result = decide({
    items: [item({ passed: true, weight: 0.4 }), item({ passed: true, weight: 0.6, checklistItemId: "b" })],
    challengeCodeSeen: "a7k2",
    challengeCodeConfidence: 0.9,
    issuedCode: issued,
  });
  assert.equal(result.decision, "pass");
  assert.equal(result.score, 1);
});

test("normalizes weights that do not sum to 1", () => {
  const result = decide({
    items: [item({ passed: true, weight: 2 }), item({ passed: false, weight: 2, required: false, confidence: 0.99 })],
    challengeCodeSeen: issued,
    challengeCodeConfidence: 0.9,
    issuedCode: issued,
    threshold: 0.5,
  });
  assert.equal(result.score, 0.5);
  assert.equal(result.decision, "pass");
});

test("fails a required item that missed at high confidence", () => {
  const result = decide({
    items: [item({ passed: false, confidence: 0.9 })],
    challengeCodeSeen: issued,
    challengeCodeConfidence: 0.9,
    issuedCode: issued,
  });
  assert.equal(result.decision, "fail");
});

test("a low-confidence item miss is unsure", () => {
  const result = decide({
    items: [item({ passed: false, confidence: 0.4 })],
    challengeCodeSeen: issued,
    challengeCodeConfidence: 0.9,
    issuedCode: issued,
  });
  assert.equal(result.decision, "unsure");
});

test("a wrong challenge code at high confidence fails", () => {
  const result = decide({
    items: [item({ passed: true })],
    challengeCodeSeen: "ZZZZ",
    challengeCodeConfidence: 0.8,
    issuedCode: issued,
  });
  assert.equal(result.decision, "fail");
});

test("a wrong challenge code at low confidence is unsure", () => {
  const result = decide({
    items: [item({ passed: true })],
    challengeCodeSeen: null,
    challengeCodeConfidence: 0.2,
    issuedCode: issued,
  });
  assert.equal(result.decision, "unsure");
});

test("a low score is not a pass even when items passed", () => {
  const result = decide({
    items: [
      item({ passed: true, weight: 0.5 }),
      item({ passed: false, weight: 0.5, required: false, confidence: 0.2, checklistItemId: "opt" }),
    ],
    challengeCodeSeen: issued,
    challengeCodeConfidence: 0.9,
    issuedCode: issued,
    threshold: 0.8,
  });
  assert.equal(result.decision, "unsure");
});
