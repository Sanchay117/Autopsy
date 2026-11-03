import { r2, schemesOf, toUsd, type UsdRates } from "./money";
import type {
  BookEntry,
  Break,
  Conversion,
  Currency,
  Deposit,
  EmailClaims,
  Movement,
  Pocket,
  Transfer,
} from "./types";

/** What Airwallex says happened to the objects this audit tracks. */
export interface Ground {
  transfers: Transfer[];
  conversions: Conversion[];
  deposits: Deposit[];
}

/** A line Autopsy writes into the books when it explains or fixes a break. */
export interface JournalLine {
  id: string;
  at: string;
  entryId?: string;
  currency: Currency;
  amount: number;
  kind: "FX_GAIN" | "FEE_EXPENSE" | "REOPEN" | "BANK_CHARGE" | "TOPUP" | "PAYMENT" | "RECEIPT" | "METAL_SETTLEMENT";
  memo: string;
}

const ACTIVE = new Set(["PROCESSING", "SENT", "PAID"]);

/**
 * Turn Airwallex objects into signed balance changes, following the documented
 * rules: a payout leaves with its fee, and a failed or cancelled transfer comes
 * back without the fee.
 */
export function movementsFrom(g: Ground): Movement[] {
  const out: Movement[] = [];
  for (const d of g.deposits) {
    out.push({ id: `${d.id}:in`, at: d.created_at, currency: d.currency, amount: d.amount, kind: "DEPOSIT", sourceId: d.id, ref: d.payer_name });
  }
  for (const c of g.conversions) {
    out.push({ id: `${c.id}:sell`, at: c.created_at, currency: c.sell_currency, amount: -c.sell_amount, kind: "CONVERSION_SELL", sourceId: c.id, ref: c.metadata.plan ?? c.request_id });
    out.push({ id: `${c.id}:buy`, at: c.created_at, currency: c.buy_currency, amount: c.buy_amount, kind: "CONVERSION_BUY", sourceId: c.id, ref: c.metadata.plan ?? c.request_id });
  }
  for (const t of g.transfers) {
    const ref = t.metadata.invoice ?? t.reference;
    out.push({ id: `${t.id}:out`, at: t.created_at, currency: t.transfer_currency, amount: -t.transfer_amount, kind: "PAYOUT", sourceId: t.id, ref });
    if (t.fee_amount) {
      out.push({ id: `${t.id}:fee`, at: t.created_at, currency: t.fee_currency, amount: -t.fee_amount, kind: "PAYOUT_FEE", sourceId: t.id, ref });
    }
    if (t.status === "CANCELLED") {
      const at = t.history.at(-1)?.at ?? t.created_at;
      out.push({ id: `${t.id}:refund`, at, currency: t.transfer_currency, amount: t.transfer_amount, kind: "PAYOUT_REFUND", sourceId: t.id, ref });
    }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

export function bankBalance(pocket: Pocket, moves: Movement[], openingDeposited: boolean) {
  const base = openingDeposited ? 0 : pocket.opening;
  return r2(base + moves.filter((m) => m.currency === pocket.currency).reduce((s, m) => s + m.amount, 0));
}

export function matchDeposit(entry: BookEntry, deposits: Deposit[]) {
  const name = entry.counterparty.toUpperCase();
  return deposits.find(
    (d) =>
      d.currency === entry.currency &&
      (d.payer_name.toUpperCase().includes(name) || d.payer_name.includes(entry.id)) &&
      Math.abs(d.amount - entry.amount) <= entry.amount * 0.01,
  );
}

/** The books' view of each pocket: opening, plus what the entries say happened. */
export function booksBalance(pocket: Pocket, books: BookEntry[], journal: JournalLine[], deposits: Deposit[]) {
  let bal = pocket.opening;
  for (const e of books) {
    if (e.kind === "payable" && e.booked === "paid" && e.currency === pocket.currency) bal -= e.amount;
    if (e.kind === "fx_plan" && e.booked === "converted") {
      if (e.currency === pocket.currency) bal += e.amount;
      if (e.sellCurrency === pocket.currency) bal -= e.amount / (e.plannedRate ?? 1);
    }
    // Standard auto-match: a receipt found in the bank is booked at its invoice amount.
    if (e.kind === "receivable" && e.currency === pocket.currency && matchDeposit(e, deposits)) bal += e.amount;
  }
  for (const j of journal) if (j.currency === pocket.currency) bal += j.amount;
  return r2(bal);
}

export interface Detection {
  breaks: Break[];
  pockets: {
    currency: Currency;
    bank: number;
    books: number;
    variance: number;
    explained: number;
    residual: number;
    reserveFloor: number;
  }[];
}

/**
 * Lay the books against the bank and list every place they disagree. Each
 * break carries its own share of a pocket's variance, so anything left over
 * is reported as residual rather than hidden.
 */
export function detect(args: {
  books: BookEntry[];
  journal: JournalLine[];
  pockets: Pocket[];
  ground: Ground;
  claims: EmailClaims[];
  auditDate: string;
  sentOn: Record<string, string>;
  rates: UsdRates;
  openingDeposited: boolean;
}): Detection {
  const { books, journal, ground, claims, auditDate, rates } = args;
  const breaks: Break[] = [];
  const journaled = (entryId: string, kind: JournalLine["kind"]) =>
    journal.some((j) => j.entryId === entryId && j.kind === kind);

  for (const e of books.filter((b) => b.kind === "payable" && b.booked === "paid")) {
    const ts = ground.transfers.filter((t) => t.metadata.invoice === e.id);
    const active = ts.filter((t) => ACTIVE.has(t.status));
    const returned = ts.filter((t) => t.status === "CANCELLED" && t.failure_type && t.failure_type !== "CLIENT_REQUESTED");

    if (active.length >= 2) {
      const extras = active.slice(1);
      const v = -extras.reduce((s, t) => s + t.transfer_amount + t.fee_amount, 0);
      breaks.push({
        id: `BRK-DUP-${e.id}`,
        kind: "DUPLICATE_PAYMENT",
        title: `${e.counterparty} paid twice for ${e.id}`,
        entryIds: [e.id],
        currency: e.currency,
        variance: r2(v),
        varianceUsd: toUsd(v, e.currency, rates),
        exposureUsd: toUsd(-v, e.currency, rates),
        objectIds: active.map((t) => t.id),
        evidenceIds: active.map((t) => `ev:${t.id}`),
      });
    }

    if (active.length === 0 && returned.length > 0 && !journaled(e.id, "REOPEN") && !journaled(e.id, "METAL_SETTLEMENT")) {
      const t = returned.at(-1)!;
      breaks.push({
        id: `BRK-RET-${e.id}`,
        kind: "RETURNED_AFTER_BOOKED_PAID",
        title: `${e.id} is paid in the books, but the bank sent it back`,
        entryIds: [e.id],
        currency: e.currency,
        variance: t.transfer_amount,
        varianceUsd: toUsd(t.transfer_amount, e.currency, rates),
        exposureUsd: toUsd(e.amount, e.currency, rates),
        objectIds: returned.map((x) => x.id),
        evidenceIds: returned.map((x) => `ev:${x.id}`),
      });
    }

    const claim = claims.find((c) => c.claim === "payment_not_received" && c.invoiceRefs.includes(e.id));
    const sent = active.find((t) => t.status === "SENT");
    if (active.length === 1 && sent && claim) {
      const age = days(args.sentOn[e.id] ?? sent.created_at.slice(0, 10), auditDate);
      breaks.push({
        id: `BRK-FLT-${e.id}`,
        kind: "IN_FLIGHT_DISPUTED",
        title: `${e.counterparty} says ${e.id} never arrived (SENT ${age} days ago)`,
        entryIds: [e.id],
        currency: e.currency,
        variance: 0,
        varianceUsd: 0,
        exposureUsd: toUsd(e.amount, e.currency, rates),
        objectIds: [sent.id],
        evidenceIds: [`ev:${sent.id}`, `ev:${claim.emailId}`],
      });
    }
  }

  // Fees: the books never record payout fees, so any fee not yet journaled is a break.
  for (const cur of ["EUR", "USD", "GBP"] as Currency[]) {
    const feeTransfers = ground.transfers.filter((t) => t.fee_currency === cur && t.fee_amount > 0);
    const fees = feeTransfers.reduce((s, t) => s + t.fee_amount, 0);
    const bookings = journal.filter((j) => j.kind === "FEE_EXPENSE" && j.currency === cur);
    const booked = -bookings.reduce((s, j) => s + j.amount, 0);
    const unbooked = r2(fees - booked);
    if (unbooked > 0.004) {
      // Fees already booked cover the oldest payouts. The break is the newest ones, under a
      // fresh id, because a fixed break is never redecided.
      const open: Transfer[] = [];
      let left = unbooked;
      for (const t of [...feeTransfers].sort((a, b) => b.created_at.localeCompare(a.created_at))) {
        if (left <= 0.004) break;
        open.unshift(t);
        left = r2(left - t.fee_amount);
      }
      // A pocket filled by a conversion was never funded for its fees; the funding pocket just never booked them.
      const funded = books.some((b) => b.kind === "fx_plan" && b.currency === cur);
      breaks.push({
        id: bookings.length ? `BRK-FEE-${cur}-${bookings.length + 1}` : `BRK-FEE-${cur}`,
        kind: "FEE_NOT_FUNDED",
        title: `${cur} pocket is ${cur} ${unbooked.toFixed(2)} short: ${schemesOf(open)} fees never ${funded ? "funded" : "booked"}`,
        entryIds: books.filter((b) => b.kind === "fx_plan" && b.currency === cur).map((b) => b.id),
        currency: cur,
        variance: -unbooked,
        varianceUsd: toUsd(-unbooked, cur, rates),
        exposureUsd: 0,
        objectIds: open.map((t) => t.id),
        evidenceIds: open.map((t) => `ev:${t.id}`),
      });
    }
  }

  for (const e of books.filter((b) => b.kind === "receivable")) {
    const dep = matchDeposit(e, ground.deposits);
    if (!dep && e.due < auditDate) {
      breaks.push({
        id: `BRK-RCV-${e.id}`,
        kind: "RECEIPT_MISSING",
        title: `${e.counterparty} owes ${e.currency} ${e.amount.toLocaleString("en-US")}, due ${days(e.due, auditDate)} days ago`,
        entryIds: [e.id],
        currency: e.currency,
        variance: 0,
        varianceUsd: 0,
        exposureUsd: toUsd(e.amount, e.currency, rates),
        objectIds: [],
        evidenceIds: [`ev:${e.id}`],
      });
    }
    if (dep && dep.amount < e.amount && !journaled(e.id, "BANK_CHARGE")) {
      const v = r2(dep.amount - e.amount);
      breaks.push({
        id: `BRK-SHT-${e.id}`,
        kind: "RECEIPT_SHORT",
        title: `${e.counterparty} paid ${e.currency} ${Math.abs(v).toFixed(2)} less than invoiced`,
        entryIds: [e.id],
        currency: e.currency,
        variance: v,
        varianceUsd: toUsd(v, e.currency, rates),
        exposureUsd: 0,
        objectIds: [dep.id],
        evidenceIds: [`ev:${dep.id}`],
      });
    }
  }

  for (const e of books.filter((b) => b.kind === "fx_plan" && b.booked === "converted")) {
    const c = ground.conversions.find((x) => x.metadata.plan === e.id);
    if (!c || journaled(e.id, "FX_GAIN")) continue;
    const plannedSell = e.amount / (e.plannedRate ?? 1);
    const v = r2(plannedSell - c.sell_amount);
    if (Math.abs(v) >= 1) {
      breaks.push({
        id: `BRK-FX-${e.id}`,
        kind: "FX_RATE_VARIANCE",
        title: `${e.id} cost ${c.sell_currency} ${Math.abs(v).toFixed(2)} ${v > 0 ? "less" : "more"} than the plan booked`,
        entryIds: [e.id],
        currency: c.sell_currency,
        variance: v,
        varianceUsd: toUsd(v, c.sell_currency, rates),
        exposureUsd: 0,
        objectIds: [c.id],
        evidenceIds: [`ev:${c.id}`],
      });
    }
  }

  const moves = movementsFrom(ground);
  const pockets = args.pockets.map((p) => {
    const bank = bankBalance(p, moves, args.openingDeposited);
    const bk = booksBalance(p, books, journal, ground.deposits);
    const variance = r2(bank - bk);
    const explained = r2(breaks.filter((b) => b.currency === p.currency).reduce((s, b) => s + b.variance, 0));
    return { currency: p.currency, bank, books: bk, variance, explained, residual: r2(variance - explained), reserveFloor: p.reserveFloor };
  });

  return { breaks, pockets };
}

export function days(from: string, to: string) {
  return Math.round((Date.parse(to.slice(0, 10)) - Date.parse(from.slice(0, 10))) / 86_400_000);
}
