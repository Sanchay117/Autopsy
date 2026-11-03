import { createHash } from "node:crypto";
import type { AirwallexRail } from "@/lib/rails/airwallex/rail";
import type { Transfer } from "./types";

const LIVE = new Set(["PROCESSING", "SENT", "PAID"]);

export class LockRefused extends Error {
  constructor(public holder: Transfer) {
    super(`Duplicate lock: ${holder.short_reference_id} is ${holder.status}. No second payment while one is live.`);
  }
}

/**
 * One live payment per obligation. Before any new attempt the lock re-reads
 * every earlier attempt from Airwallex, so it acts on the bank's state, not on
 * what the books or the model believe.
 */
export class DuplicateLock {
  /** `ns` keeps ids unique across demo reseeds inside the 7-day window. */
  constructor(private rail: AirwallexRail, private ns: string) {}

  /** Deterministic per key, so a retry after a timeout reuses the same id. */
  requestId(key: string) {
    const tag = createHash("sha256").update(`${this.ns}:${key}`).digest("hex").slice(0, 8);
    return `apx-${key.slice(0, 36)}-${tag}`;
  }

  async assertFree(priorIds: string[]) {
    for (const id of priorIds) {
      const t = await this.rail.getTransfer(id);
      if (LIVE.has(t.status)) throw new LockRefused(t);
    }
  }

  /**
   * Create a payment under the lock. If the same request_id already reached
   * Airwallex (a retry after a lost response), return that transfer instead.
   */
  async pay(
    obligation: string,
    priorIds: string[],
    create: (requestId: string) => Promise<Transfer>,
  ): Promise<{ transfer: Transfer; reused: boolean }> {
    await this.assertFree(priorIds);
    const requestId = this.requestId(`${obligation}-r${priorIds.length + 1}`);
    const existing = await this.rail.findTransferByRequestId(requestId);
    if (existing) return { transfer: existing, reused: true };
    return { transfer: await create(requestId), reused: false };
  }
}
