import { r2 } from "./money";
import type { Currency, Movement } from "./types";

export interface ReplayResult {
  final: number;
  min: number;
  /** Movement at which the balance first fell below the floor, if any. */
  breachAt?: Movement;
}

/** Walk one pocket's movements in time order. Pure: same input, same answer. */
export function replay(moves: Movement[], currency: Currency, opening: number, floor = 0): ReplayResult {
  let bal = opening;
  // An empty pocket is not a low point: measure from the first time it holds money.
  let min = opening > 0 ? opening : Number.POSITIVE_INFINITY;
  let breachAt: Movement | undefined;
  for (const m of moves) {
    if (m.currency !== currency) continue;
    bal = r2(bal + m.amount);
    if (bal < min) min = bal;
    if (bal < floor - 0.004 && !breachAt) breachAt = m;
  }
  return { final: r2(bal), min: r2(Number.isFinite(min) ? min : opening), breachAt };
}

/**
 * Counterfactual by intervention: change one recorded event, replay the rest
 * exactly as Airwallex reported it, and compare outcomes.
 */
export function intervene(
  moves: Movement[],
  change: { drop?: (m: Movement) => boolean; adjust?: (m: Movement) => Movement | null },
): Movement[] {
  return moves.flatMap((m) => {
    if (change.drop?.(m)) return [];
    const next = change.adjust ? change.adjust(m) : m;
    return next ? [next] : [];
  });
}
