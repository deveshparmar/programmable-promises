import { z } from "zod";
import { MAX_AMOUNT_MINOR, MIN_AMOUNT_MINOR } from "./transitions.js";

export const checklistItemSchema = z.object({
  text: z.string().trim().min(3).max(400),
  weight: z.number().positive().max(100),
  required: z.boolean(),
});

export const generatedChecklistSchema = z.object({
  title: z.string().trim().min(1).max(140),
  pass_threshold: z.number().min(0).max(1).optional(),
  items: z.array(checklistItemSchema).min(1).max(8),
});

export const modelVerificationSchema = z.object({
  overall: z.enum(["pass", "fail", "unsure"]).optional(),
  score: z.number().optional(),
  confidence: z.number().min(0).max(1).optional(),
  items: z
    .array(
      z.object({
        checklist_item_id: z.string().uuid(),
        passed: z.boolean(),
        confidence: z.number().min(0).max(1),
        evidence: z.string().trim().min(1).max(600),
      }),
    )
    .default([]),
  challenge_code_seen: z.string().trim().max(32).nullable().optional(),
  challenge_code_confidence: z.number().min(0).max(1).optional(),
  worker_feedback: z.string().trim().max(800).optional(),
});

export const createPromiseSchema = z.object({
  title: z.string().trim().min(1).max(140).optional(),
  description: z.string().trim().min(10).max(4000),
  amount_minor: z.number().int().min(MIN_AMOUNT_MINOR).max(MAX_AMOUNT_MINOR),
  worker_email: z.string().trim().email().max(200),
  deadline_at: z.string().min(1),
});

export const updateChecklistSchema = z.object({
  items: z.array(checklistItemSchema).min(1, "Add at least one checklist item.").max(8),
  pass_threshold: z.number().min(0.5).max(1).optional(),
  confirm: z.boolean().optional(),
  deadline_at: z.string().min(1).optional(),
});

export const reviewSchema = z.object({
  decision: z.enum(["approve", "deny"]),
  note: z.string().trim().max(1000).optional(),
  amount_minor: z.number().int().optional(),
  currency: z.string().optional(),
  worker_email: z.string().optional(),
  checklist_version: z.number().int().optional(),
});

export type GeneratedChecklist = z.infer<typeof generatedChecklistSchema>;
export type ModelVerification = z.infer<typeof modelVerificationSchema>;
