import { ITEM_CONFIDENCE_MIN, PASS_THRESHOLD_DEFAULT } from "./transitions.js";

export interface DecisionItem {
  checklistItemId: string;
  passed: boolean;
  confidence: number;
  weight: number;
  required: boolean;
}

export interface DecisionInput {
  items: DecisionItem[];
  challengeCodeSeen: string | null;
  challengeCodeConfidence: number;
  issuedCode: string;
  threshold?: number;
}

export type Decision = "pass" | "fail" | "unsure";

export interface DecisionResult {
  decision: Decision;
  score: number;
  reason: string;
}

function codesMatch(seen: string | null, issued: string): boolean {
  if (!seen) return false;
  return seen.trim().toUpperCase() === issued.trim().toUpperCase();
}

export function decide(input: DecisionInput): DecisionResult {
  const threshold = input.threshold ?? PASS_THRESHOLD_DEFAULT;
  const weightTotal = input.items.reduce((sum, item) => sum + item.weight, 0);
  const passedWeight = input.items
    .filter((item) => item.passed)
    .reduce((sum, item) => sum + item.weight, 0);
  const score = weightTotal > 0 ? passedWeight / weightTotal : 0;

  const clearItemFail = input.items.some(
    (item) => item.required && !item.passed && item.confidence >= ITEM_CONFIDENCE_MIN,
  );
  const codeMatches = codesMatch(input.challengeCodeSeen, input.issuedCode);
  const clearCodeFail = !codeMatches && input.challengeCodeConfidence >= ITEM_CONFIDENCE_MIN;

  if (clearItemFail) {
    return { decision: "fail", score, reason: "A required checklist item failed." };
  }
  if (clearCodeFail) {
    return { decision: "fail", score, reason: "The challenge code was missing or wrong." };
  }

  const required = input.items.filter((item) => item.required);
  const requiredPass =
    required.length > 0 &&
    required.every((item) => item.passed && item.confidence >= ITEM_CONFIDENCE_MIN);
  if (requiredPass && score >= threshold && codeMatches) {
    return { decision: "pass", score, reason: "Required items passed and the challenge code matched." };
  }
  return { decision: "unsure", score, reason: "The proof was not a clear pass or a clear fail." };
}
