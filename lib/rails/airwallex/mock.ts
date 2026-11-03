import { randomUUID } from "node:crypto";
import { r2, SWIFT_FEE } from "@/lib/engine/money";
import type {
  Conversion,
  Currency,
  Deposit,
  Transfer,
  TransferStatus,
} from "@/lib/engine/types";
import { RailError, type AirwallexRail, type CreateConversion, type CreateTransfer } from "./rail";

/** Units of the bought currency per one USD, as the mock quotes them. */
const MOCK_RATES: Record<string, number> = { USDEUR: 0.9208, USDGBP: 0.7864, EURUSD: 1 / 0.9208, GBPUSD: 1 / 0.7864 };

/**
 * Offline stand-in for the Airwallex sandbox. It follows the rules the builder
 * guide and docs state: SWIFT payouts carry a flat fee, a failure ends in
 * CANCELLED with the amount refunded less the fee, request_ids cannot repeat,
 * and a transfer can still fail after PAID.
 */
export class MockAirwallex implements AirwallexRail {
  mode = "mock" as const;
  private transfers = new Map<string, Transfer>();
  private conversions = new Map<string, Conversion>();
  private deposits = new Map<string, Deposit>();
  private requestIds = new Set<string>();
  private clock: () => string;

  constructor(clock: () => string = () => new Date().toISOString()) {
    this.clock = clock;
  }

  private claim(requestId: string) {
    if (this.requestIds.has(requestId)) {
      throw new RailError("duplicate_request_id", `request_id ${requestId} was used in the last 7 days`, 400);
    }
    this.requestIds.add(requestId);
  }

  async createTransfer(req: CreateTransfer): Promise<Transfer> {
    this.claim(req.request_id);
    const now = this.clock();
    const t: Transfer = {
      id: randomUUID(),
      request_id: req.request_id,
      short_reference_id: `P${now.slice(2, 10).replace(/-/g, "")}-${randomUUID().slice(0, 6).toUpperCase()}`,
      beneficiary_id: req.beneficiary.id,
      transfer_amount: r2(req.amount),
      transfer_currency: req.currency,
      transfer_method: req.method,
      fee_amount: req.method === "SWIFT" ? SWIFT_FEE[req.currency] : 0,
      fee_currency: req.currency,
      reference: req.reference,
      status: "PROCESSING",
      history: [{ status: "PROCESSING", at: now }],
      metadata: req.metadata,
      created_at: now,
    };
    this.transfers.set(t.id, t);
    return structuredClone(t);
  }

  async getTransfer(id: string) {
    const t = this.transfers.get(id);
    if (!t) throw new RailError("not_found", `transfer ${id}`, 404);
    return structuredClone(t);
  }

  async findTransferByRequestId(requestId: string) {
    for (const t of this.transfers.values()) if (t.request_id === requestId) return structuredClone(t);
    return undefined;
  }

  async transition(id: string, next: TransferStatus, failureType?: string) {
    const t = this.transfers.get(id);
    if (!t) throw new RailError("not_found", `transfer ${id}`, 404);
    const allowed: Record<TransferStatus, TransferStatus[]> = {
      PROCESSING: ["SENT", "FAILED", "CANCELLED"],
      SENT: ["PAID", "FAILED"],
      PAID: ["FAILED"],
      FAILED: ["CANCELLED"],
      CANCELLED: [],
    };
    if (!allowed[t.status].includes(next)) {
      throw new RailError("invalid_status_transition", `${t.status} -> ${next}`, 400);
    }
    const now = this.clock();
    t.status = next;
    t.history.push({ status: next, at: now });
    if (next === "FAILED") {
      t.failure_type = failureType ?? "OTHER";
      t.failure_reason = FAILURE_REASONS[t.failure_type] ?? "99902: Other";
      // Failed transfers are cancelled automatically within seconds.
      t.status = "CANCELLED";
      t.history.push({ status: "CANCELLED", at: now });
    }
    return structuredClone(t);
  }

  async cancelTransfer(id: string) {
    const t = this.transfers.get(id);
    if (!t) throw new RailError("not_found", `transfer ${id}`, 404);
    if (!["PROCESSING", "FAILED"].includes(t.status)) {
      throw new RailError("invalid_status_for_operation", `cannot cancel a ${t.status} transfer`, 400);
    }
    t.status = "CANCELLED";
    t.failure_type ??= "CLIENT_REQUESTED";
    t.failure_reason ??= "91002: Client requested";
    t.history.push({ status: "CANCELLED", at: this.clock() });
    return structuredClone(t);
  }

  async convert(req: CreateConversion): Promise<Conversion> {
    this.claim(req.request_id);
    const pair = `${req.sell_currency}${req.buy_currency}`;
    const rate = MOCK_RATES[pair];
    if (!rate) throw new RailError("unsupported_currency_pair", pair, 400);
    const c: Conversion = {
      id: randomUUID(),
      request_id: req.request_id,
      buy_currency: req.buy_currency,
      sell_currency: req.sell_currency,
      buy_amount: r2(req.buy_amount),
      sell_amount: r2(req.buy_amount / rate),
      client_rate: rate,
      status: "SETTLED",
      created_at: this.clock(),
      metadata: req.metadata,
    };
    this.conversions.set(c.id, c);
    return structuredClone(c);
  }

  async getConversion(id: string) {
    const c = this.conversions.get(id);
    if (!c) throw new RailError("not_found", `conversion ${id}`, 404);
    return structuredClone(c);
  }

  async simulateDeposit(req: { amount: number; currency: Currency; payer_name: string }) {
    const d: Deposit = {
      id: randomUUID(),
      amount: r2(req.amount),
      currency: req.currency,
      payer_name: req.payer_name,
      reference: req.payer_name,
      created_at: this.clock(),
    };
    this.deposits.set(d.id, d);
    return structuredClone(d);
  }

  async getDeposit(id: string) {
    const d = this.deposits.get(id);
    if (!d) throw new RailError("not_found", `deposit ${id}`, 404);
    return structuredClone(d);
  }
}

/** failure_type to failure_reason, as the transition docs list them. */
export const FAILURE_REASONS: Record<string, string> = {
  INVALID_ACCOUNT_NAME_OR_NUMBER: "90101: Invalid account name/number",
  INVALID_SWIFT_BIC_CODE: "90202: Invalid SWIFT/BIC code",
  BENEFICIARY_NAME_MISMATCH: "90301: Beneficiary name mismatch",
  ACCOUNT_CLOSED: "90701: Account closed",
  ACCOUNT_INACTIVE_OR_DORMANT: "90702: Account inactive or dormant",
  BENEFICIARY_BANK_RETURNED: "90802: Beneficiary bank returned",
  RECALL_REQUESTED: "91001: Recall requested",
  CLIENT_REQUESTED: "91002: Client requested",
  CHANNEL_TIMEOUT: "91402: Channel timeout",
  DUPLICATION_RETURN: "Duplication return",
  OTHER: "99902: Other",
};
