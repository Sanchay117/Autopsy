import { r2 } from "@/lib/engine/money";
import type { Conversion, Currency, Deposit, Transfer, TransferStatus } from "@/lib/engine/types";
import { RailError, type AirwallexRail, type CreateConversion, type CreateTransfer } from "./rail";

const BASE = process.env.AWX_BASE_URL ?? "https://api.sandbox.airwallex.com";

type Json = Record<string, unknown>;

/**
 * REST client for the Airwallex sandbox. Field names follow the API reference:
 * transfers/create takes transfer_amount and transfer_currency, conversions
 * live at /api/v1/fx/conversions (the path every API version accepts), and
 * every create carries a request_id.
 */
export class SandboxAirwallex implements AirwallexRail {
  mode = "sandbox" as const;
  private token?: { value: string; expires: number };
  // FX conversions come back without our metadata, and a simulated deposit can take a
  // moment to become readable. Keep what this client created so later reads stay whole.
  private made = { conversions: new Map<string, Record<string, string>>(), deposits: new Map<string, Deposit>() };

  constructor(
    private clientId: string,
    private apiKey: string,
    private usdGlobalAccountId: string,
  ) {}

  private async login() {
    if (this.token && Date.now() < this.token.expires) return this.token.value;
    const res = await fetch(`${BASE}/api/v1/authentication/login`, {
      method: "POST",
      headers: { "x-client-id": this.clientId, "x-api-key": this.apiKey },
    });
    if (!res.ok) throw new RailError("credentials_invalid", await res.text(), res.status);
    const body = (await res.json()) as { token: string };
    // Tokens last 30 minutes. Refresh a little early.
    this.token = { value: body.token, expires: Date.now() + 25 * 60_000 };
    return body.token;
  }

  /** Any authenticated call. Public so the setup and feasibility scripts share the login and backoff. */
  async call<T>(method: "GET" | "POST", path: string, body?: Json): Promise<T> {
    const token = await this.login();
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${BASE}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          // Simulating PAID needs 2024-04-30 or later. Without this the account's default version applies.
          ...(process.env.AWX_API_VERSION ? { "x-api-version": process.env.AWX_API_VERSION } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      // The sandbox allows 10 requests per second per endpoint. Back off on 429.
      if (res.status === 429 && attempt < 4) {
        await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
        continue;
      }
      const text = await res.text();
      const json = text ? (JSON.parse(text) as Json) : {};
      if (!res.ok) {
        // Validation failures name the field in `source` or an `errors` list. Keep them, or the message says nothing useful.
        const detail = [json.source, json.errors, json.details].filter(Boolean).map((d) => (typeof d === "string" ? d : JSON.stringify(d)));
        throw new RailError(String(json.code ?? res.status), [String(json.message ?? text), ...detail].join(" "), res.status);
      }
      return json as T;
    }
  }

  async createTransfer(req: CreateTransfer) {
    const body = {
      request_id: req.request_id,
      beneficiary_id: req.beneficiary.id,
      transfer_amount: String(req.amount),
      transfer_currency: req.currency,
      source_currency: req.currency,
      transfer_method: req.method,
      reason: "payment_to_supplier",
      reference: req.reference,
      metadata: req.metadata,
    };
    // The sandbox sometimes answers fee_unknown when SWIFT payouts come close together,
    // then prices the same payout a few seconds later. Nothing is created on that error,
    // and the retry reuses the request_id, so it cannot pay twice.
    for (let attempt = 0; ; attempt++) {
      try {
        return toTransfer(await this.call<Json>("POST", "/api/v1/transfers/create", body));
      } catch (err) {
        if (!(err instanceof RailError) || err.code !== "fee_unknown" || attempt >= 5) throw err;
        await new Promise((r) => setTimeout(r, 1_500 * 2 ** attempt));
      }
    }
  }

  async getTransfer(id: string) {
    return toTransfer(await this.call<Json>("GET", `/api/v1/transfers/${id}`));
  }

  async findTransferByRequestId(requestId: string) {
    const page = await this.call<{ items?: Json[] }>(
      "GET",
      `/api/v1/transfers?request_id=${encodeURIComponent(requestId)}`,
    );
    const first = page.items?.[0];
    return first ? toTransfer(first) : undefined;
  }

  async transition(id: string, next: TransferStatus, failureType?: string) {
    // A new transfer is SCHEDULED for about a second before the sandbox moves it
    // to PROCESSING, and it refuses simulated transitions until then (operation_failed).
    const raw = async () => (await this.call<Json>("GET", `/api/v1/transfers/${id}`)).status;
    for (let i = 0; i < 20 && (await raw()) === "SCHEDULED"; i++) {
      await new Promise((r) => setTimeout(r, 500));
    }
    const body: Json = { next_status: next };
    if (failureType) body.failure_type = failureType;
    await this.call<Json>("POST", `/api/v1/simulation/transfers/${id}/transition`, body);
    // FAILED is followed by an automatic cancel. Read back the settled state.
    return this.getTransfer(id);
  }

  async cancelTransfer(id: string) {
    // A payout refuses cancel (update_unsupported) while SCHEDULED and for a moment after it
    // turns PROCESSING. Retry briefly in those states only; one that has left keeps refusing.
    for (let attempt = 0; ; attempt++) {
      try {
        await this.call<Json>("POST", `/api/v1/transfers/${id}/cancel`);
        return this.getTransfer(id);
      } catch (err) {
        if (!(err instanceof RailError) || err.code !== "update_unsupported" || attempt >= 6) throw err;
        const status = (await this.call<Json>("GET", `/api/v1/transfers/${id}`)).status;
        if (status !== "SCHEDULED" && status !== "PROCESSING") throw err;
        await new Promise((r) => setTimeout(r, 1_000));
      }
    }
  }

  async convert(req: CreateConversion) {
    const c = await this.call<Json>("POST", "/api/v1/fx/conversions/create", {
      request_id: req.request_id,
      buy_currency: req.buy_currency,
      sell_currency: req.sell_currency,
      buy_amount: String(req.buy_amount),
      // Required by older API versions, which an account may still be pinned to.
      term_agreement: true,
    });
    const conv = toConversion(c, req.metadata);
    this.made.conversions.set(conv.id, req.metadata);
    return conv;
  }

  async getConversion(id: string) {
    return toConversion(await this.call<Json>("GET", `/api/v1/fx/conversions/${id}`), this.made.conversions.get(id) ?? {});
  }

  async simulateDeposit(req: { amount: number; currency: Currency; payer_name: string }) {
    // The deposit lands in the Global Account's currency. The audit funds USD only.
    const d = await this.call<Json>("POST", "/api/v1/simulation/deposit/create", {
      global_account_id: this.usdGlobalAccountId,
      amount: req.amount,
      payer_name: req.payer_name,
    });
    const dep = toDeposit(d, req);
    this.made.deposits.set(dep.id, dep);
    return dep;
  }

  async getDeposit(id: string) {
    const known = this.made.deposits.get(id);
    for (let attempt = 0; ; attempt++) {
      try {
        return toDeposit(await this.call<Json>("GET", `/api/v1/deposits/${id}`), known);
      } catch (err) {
        if (!(err instanceof RailError) || !/not found/i.test(err.message)) throw err;
        if (attempt < 3) await new Promise((r) => setTimeout(r, 1_000));
        else if (known) return known;
        else throw err;
      }
    }
  }
}

// SCHEDULED is live but not yet processing. The engine treats it as PROCESSING,
// so the duplicate lock counts a payment from the moment it is created.
const statusOf = (s: unknown) => (s === "SCHEDULED" ? "PROCESSING" : s) as TransferStatus;

// The sandbox puts a category in failure_type (INCORRECT_ROUTING) and the specific
// reason in failure_reason ("90701: Account closed"). Read the specific one from its code.
const FAILURE_CODES: Record<string, string> = { "90701": "ACCOUNT_CLOSED", "90802": "BENEFICIARY_BANK_RETURNED" };

function toTransfer(t: Json): Transfer {
  const failure = (t.failure ?? {}) as Json;
  const code = String(t.failure_reason ?? failure.reason ?? "").match(/^(\d{5})\b/)?.[1];
  return {
    id: String(t.id),
    request_id: String(t.request_id),
    short_reference_id: String(t.short_reference_id ?? ""),
    beneficiary_id: String(t.beneficiary_id ?? ""),
    transfer_amount: Number(t.transfer_amount),
    transfer_currency: t.transfer_currency as Currency,
    transfer_method: (t.transfer_method ?? "LOCAL") as Transfer["transfer_method"],
    fee_amount: Number(t.fee_amount ?? 0),
    fee_currency: (t.fee_currency ?? t.transfer_currency) as Currency,
    reference: String(t.reference ?? ""),
    status: statusOf(t.status),
    failure_type: ((code && FAILURE_CODES[code]) ?? t.failure_type ?? failure.type) as string | undefined,
    failure_reason: (t.failure_reason ?? failure.reason) as string | undefined,
    history: [{ status: statusOf(t.status), at: String(t.updated_at ?? t.created_at) }],
    metadata: (t.metadata ?? {}) as Record<string, string>,
    created_at: String(t.created_at),
  };
}

function toConversion(c: Json, metadata: Record<string, string>): Conversion {
  const buy = Number(c.buy_amount);
  const sell = Number(c.sell_amount);
  return {
    id: String(c.id ?? c.conversion_id),
    request_id: String(c.request_id),
    buy_currency: c.buy_currency as Currency,
    sell_currency: c.sell_currency as Currency,
    buy_amount: buy,
    sell_amount: sell,
    // Units bought per unit sold, derived from the settled amounts so the
    // direction of the quoted currency_pair never matters.
    client_rate: r2((buy / sell) * 10_000) / 10_000,
    status: "SETTLED",
    created_at: String(c.created_at ?? new Date().toISOString()),
    metadata,
  };
}

function toDeposit(d: Json, fallback?: { amount: number; currency: Currency; payer_name: string }): Deposit {
  return {
    id: String(d.id),
    amount: Number(d.amount ?? fallback?.amount),
    currency: (d.currency ?? fallback?.currency ?? "USD") as Currency,
    payer_name: String(d.payer_name ?? fallback?.payer_name ?? ""),
    reference: String(d.reference ?? d.payer_name ?? fallback?.payer_name ?? ""),
    created_at: String(d.created_at ?? new Date().toISOString()),
  };
}
