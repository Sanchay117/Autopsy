import { createHash } from "node:crypto";
import type { ActionKind } from "./types";

/**
 * Every limit the agent works under. The model never sees or sets these; it
 * reads evidence and writes explanations, and this file decides what it may do.
 */
export const POLICY = {
  version: "2026-11-01",
  /** Autonomy scales with confidence. Below 0.5 every action needs a person. */
  autonomy: [
    { min: 0.9, limitUsd: 10_000 },
    { min: 0.75, limitUsd: 2_500 },
    { min: 0.5, limitUsd: 500 },
    { min: 0, limitUsd: 0 },
  ],
  bankChargeToleranceUsd: 50,
  /** Business days a SWIFT payout may stay SENT before it counts as overdue. */
  swiftSettleDays: 5,
  /** Cost of one person handling an escalation, for comparing options. */
  opsCostUsd: 40,
  /** What a late supplier costs per day: holds, penalties, goodwill. */
  lateCostUsdPerDay: 25,
  /** Actions that always go to a person, whatever the confidence. */
  alwaysHuman: ["REQUEST_DETAILS", "ESCALATE"] as ActionKind[],
  /** Actions that only reduce money at risk may run at lower confidence. */
  riskReducing: ["CANCEL_DUPLICATE", "WAIT", "POST_ADJUSTMENT", "CHASE", "DEFER", "TOP_UP"] as ActionKind[],
  metalMandateCapUsd: 5_000,
} as const;

export function autonomyLimitUsd(confidence: number) {
  return POLICY.autonomy.find((a) => confidence >= a.min)!.limitUsd;
}

/** Hash of the exact terms shown to an approver. Any change voids the approval. */
export function bindingHash(terms: Record<string, string | number>) {
  const canonical = JSON.stringify(Object.keys(terms).sort().map((k) => [k, terms[k]]));
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}
