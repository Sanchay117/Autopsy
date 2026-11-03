import type { AirwallexRail } from "@/lib/rails/airwallex/rail";
import { RailError } from "@/lib/rails/airwallex/rail";
import type { MetalPayout, MetalRail } from "@/lib/rails/metal";
import { DuplicateLock, LockRefused } from "./lock";
import { fmt, r2, schemesOf, swiftFeeFrom } from "./money";
import type { JournalLine } from "./reconcile";
import type { Vendor } from "./scenario";
import type { ActionKind, Beneficiary, BookEntry, Break, Currency, Decision, Rule, Transfer } from "./types";

export interface Draft {
  id: string;
  decisionId: string;
  to: string;
  subject: string;
  body: string;
}

/** Everything the executor may touch. It never decides; it carries out. */
export interface ActContext {
  rail: AirwallexRail;
  metal: MetalRail;
  lock: DuplicateLock;
  ns: string;
  books: BookEntry[];
  journal: JournalLine[];
  breaks: Break[];
  transfers: Transfer[];
  vendors: Vendor[];
  beneficiaries: Record<string, Beneficiary>;
  rules: Rule[];
  now: () => string;
  track: (kind: "transfer" | "conversion", id: string) => void;
  drafts: Draft[];
  metalPayouts: (MetalPayout & { decisionId: string; invoice: string })[];
}

/** Kinds that move money or write the books. Once done, they are never redone. */
export const FINAL: ActionKind[] = ["CANCEL_DUPLICATE", "TOP_UP", "POST_ADJUSTMENT", "PAY", "REPLACE", "CONVERT", "REQUEST_DETAILS"];

export interface ActResult {
  ok: boolean;
  text: string;
  objects: string[];
}

export async function execute(ctx: ActContext, d: Decision): Promise<ActResult> {
  try {
    return await run(ctx, d);
  } catch (err) {
    if (err instanceof LockRefused) return { ok: false, text: err.message, objects: [err.holder.id] };
    if (err instanceof RailError) return { ok: false, text: `Airwallex refused: ${err.message}`, objects: [] };
    throw err;
  }
}

async function run(ctx: ActContext, d: Decision): Promise<ActResult> {
  const o = d.chosen;
  const b = ctx.breaks.find((x) => x.id === d.breakId);
  const invoice = b?.entryIds[0] ?? d.breakId.replace(/^OBL-/, "");
  const entry = ctx.books.find((x) => x.id === invoice);
  const vendor = ctx.vendors.find((v) => v.name === o.counterparty);
  const line = (l: Omit<JournalLine, "id" | "at">) =>
    ctx.journal.push({ ...l, id: `JE-${String(ctx.journal.length + 1).padStart(3, "0")}`, at: ctx.now() });
  const prior = (inv: string) => ctx.transfers.filter((t) => t.metadata.invoice === inv).map((t) => t.id);

  /** Buy `amount` of `cur` with USD and book it, so a payout can carry its own fee. */
  const fund = async (amount: number, cur: Currency, key: string, memo: string) => {
    const c = await ctx.rail.convert({
      request_id: ctx.lock.requestId(key),
      buy_currency: cur,
      sell_currency: "USD",
      buy_amount: amount,
      metadata: { autopsy: ctx.ns, plan: key },
    });
    ctx.track("conversion", c.id);
    line({ currency: cur, amount: c.buy_amount, kind: "TOPUP", memo });
    line({ currency: "USD", amount: -c.sell_amount, kind: "TOPUP", memo });
    return c;
  };

  /** Book a payout's fee with the payout, as AP would, so the next audit does not find it as a break. */
  const bookFee = (t: Transfer, upFront = 0) => {
    const rest = r2(t.fee_amount - upFront);
    if (Math.abs(rest) > 0.004) line({ entryId: invoice, currency: t.fee_currency, amount: -rest, kind: "FEE_EXPENSE", memo: `${schemesOf([t])} fee on ${invoice}, booked with the payment` });
  };

  switch (o.kind) {
    case "CANCEL_DUPLICATE": {
      const extras = b!.objectIds.slice(1);
      const done: string[] = [];
      for (const id of extras) {
        const t = await ctx.rail.getTransfer(id);
        if (t.status !== "PROCESSING") {
          return { ok: false, text: `${t.short_reference_id} is already ${t.status}; too late to cancel, a recall is needed`, objects: [id] };
        }
        const c = await ctx.rail.cancelTransfer(id);
        done.push(c.short_reference_id);
      }
      return { ok: true, text: `Cancelled ${done.join(", ")} before it left. ${fmt(o.amount, o.currency)} stays in the ${o.currency} pocket`, objects: extras };
    }

    case "TOP_UP": {
      line({ currency: o.currency, amount: -o.amount, kind: "FEE_EXPENSE", memo: `Payout fees on ${b!.objectIds.length} payouts, booked` });
      const c = await fund(o.amount, o.currency, `${d.breakId}-topup`, `Fund ${o.currency} fee shortfall`);
      return { ok: true, text: `Booked ${fmt(o.amount, o.currency)} of fees and bought it back for ${fmt(c.sell_amount, "USD")}`, objects: [c.id] };
    }

    case "POST_ADJUSTMENT": {
      const kind = b!.kind === "FX_RATE_VARIANCE" ? "FX_GAIN" : b!.kind === "FEE_NOT_FUNDED" ? "FEE_EXPENSE" : "BANK_CHARGE";
      line({ entryId: invoice, currency: b!.currency, amount: b!.variance, kind, memo: o.label });
      return { ok: true, text: `Journal: ${o.label}`, objects: [] };
    }

    case "REQUEST_DETAILS": {
      line({ entryId: invoice, currency: entry!.currency, amount: entry!.amount, kind: "REOPEN", memo: `${invoice} returned by the bank; reopened` });
      ctx.drafts.push({
        id: `DR-${ctx.drafts.length + 1}`,
        decisionId: d.id,
        to: vendor?.email ?? o.counterparty,
        subject: `${invoice}: payment returned, please send new bank details`,
        body: `Hello,\n\nour payment for ${invoice} (${fmt(entry!.amount, entry!.currency)}) was returned by your bank with the reason "account closed". Please send your new bank details on letterhead and we will pay the same day we verify them.\n\nThank you,\nAccounts payable`,
      });
      return { ok: true, text: `Reopened ${invoice} in the books and drafted a request for new details (not sent)`, objects: [] };
    }

    case "PAY": {
      const ben = ctx.beneficiaries[vendor!.id];
      const { transfer, reused } = await ctx.lock.pay(invoice, prior(invoice), (requestId) =>
        ctx.rail.createTransfer({
          request_id: requestId,
          beneficiary: ben,
          amount: o.amount,
          currency: o.currency,
          method: entry!.method ?? "LOCAL",
          reference: invoice,
          metadata: { invoice, autopsy: ctx.ns },
        }),
      );
      ctx.track("transfer", transfer.id);
      if (!reused) bookFee(transfer);
      entry!.booked = "paid";
      return { ok: true, text: `${reused ? "Found existing" : "Sent"} ${transfer.short_reference_id}: ${fmt(o.amount, o.currency)} to ${o.counterparty} (request ${transfer.request_id})`, objects: [transfer.id] };
    }

    case "REPLACE": {
      if (o.rail === "metal") {
        await ctx.lock.assertFree(prior(invoice));
        const paymentId = `${invoice}-r${prior(invoice).length + 1}-${ctx.ns}`;
        const p = await ctx.metal.payout({ to: vendor!.metalAddress!, amount: o.amount, paymentId });
        ctx.metalPayouts.push({ ...p, decisionId: d.id, invoice });
        if (p.outcome !== "paid") return { ok: false, text: `Metal ${p.outcome}: ${p.detail}`, objects: [] };
        line({ entryId: invoice, currency: entry!.currency, amount: entry!.amount, kind: "METAL_SETTLEMENT", memo: `${invoice} settled on Metal: ${fmt(o.amount, "USD")} to ${p.payee.slice(0, 10)}…` });
        const scaled = p.onChain !== undefined ? ` (sent as ${p.onChain.toFixed(2)} *USDZ: testnet amounts are scaled down)` : "";
        return { ok: true, text: `Settled ${invoice} on Metal ${ctx.metal.mode}: ${fmt(o.amount, "USD")}${scaled} to ${p.payee.slice(0, 10)}…, payment id ${paymentId}${p.transaction ? `, tx ${p.transaction.slice(0, 12)}…` : ""}`, objects: [] };
      }
      const ben = ctx.beneficiaries[vendor!.id];
      const method = entry!.method ?? "LOCAL";
      const feeAware = method === "SWIFT" && ctx.rules.some((r) => r.id === "R-FEE");
      // Lock first, so a refused replacement never buys the currency for its fee.
      await ctx.lock.assertFree(prior(invoice));
      const fee = feeAware ? swiftFeeFrom(ctx.transfers, o.currency) : 0;
      if (feeAware) {
        line({ entryId: invoice, currency: o.currency, amount: -fee, kind: "FEE_EXPENSE", memo: `SWIFT fee on ${invoice} replacement, booked up front (R-FEE)` });
        await fund(fee, o.currency, `${invoice}-fee-r${prior(invoice).length + 1}`, `Fund SWIFT fee for ${invoice} replacement (R-FEE)`);
      }
      const { transfer, reused } = await ctx.lock.pay(invoice, prior(invoice), (requestId) =>
        ctx.rail.createTransfer({
          request_id: requestId,
          beneficiary: ben,
          amount: o.amount,
          currency: o.currency,
          method,
          reference: `${invoice} replacement`,
          metadata: { invoice, autopsy: ctx.ns, replaces: prior(invoice).at(-1) ?? "" },
        }),
      );
      ctx.track("transfer", transfer.id);
      // The fee booked up front is the expected one. Book any difference from what the bank charged.
      if (!reused) bookFee(transfer, fee);
      return {
        ok: true,
        text: `Sent replacement ${transfer.short_reference_id}: ${fmt(o.amount, o.currency)} ${method}${feeAware ? `, fee ${fmt(fee, o.currency)} funded first (R-FEE)` : ""}`,
        objects: [transfer.id],
      };
    }

    case "CONVERT":
      return { ok: true, text: `Approved. Conversion of ${fmt(o.amount, o.currency)} runs on ${d.executeOn}`, objects: [] };

    case "WAIT": {
      if (b?.kind === "IN_FLIGHT_DISPUTED") {
        ctx.drafts.push({
          id: `DR-${ctx.drafts.length + 1}`,
          decisionId: d.id,
          to: vendor?.email ?? o.counterparty,
          subject: `Re: ${invoice}: payment is in transit`,
          body: `Hello,\n\nthe payment for ${invoice} (${fmt(o.amount, o.currency)}) left us by SWIFT and is still in transit. We have asked our bank for a trace and will update you within 48 hours. Please do not expect a second payment: we will not send one while this one is live.\n\nAccounts payable`,
        });
        return { ok: true, text: `Holding 48h. SWIFT trace requested and a reply to ${o.counterparty} drafted (not sent)`, objects: [] };
      }
      return { ok: true, text: `Holding: ${o.label}`, objects: [] };
    }

    case "DEFER":
      return { ok: true, text: `Holding: ${o.label}`, objects: [] };

    case "CHASE": {
      ctx.drafts.push({
        id: `DR-${ctx.drafts.length + 1}`,
        decisionId: d.id,
        to: o.counterparty,
        subject: `${invoice}: payment reminder`,
        body: `Hello,\n\nour records show ${invoice} for ${fmt(entry?.amount ?? o.amount, o.currency)} was due on ${entry?.due}. Could you confirm when it will be paid?\n\nCredit control`,
      });
      return { ok: true, text: `Reminder to ${o.counterparty} drafted (not sent)`, objects: [] };
    }

    case "ESCALATE":
      return { ok: true, text: `Handed to a person: ${o.label}`, objects: [] };
  }
  return { ok: false, text: `No executor for ${o.kind}`, objects: [] };
}

