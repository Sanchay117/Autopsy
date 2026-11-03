import { fmt, r2, schemesOf } from "./money";
import { days, movementsFrom, type Ground } from "./reconcile";
import { intervene, replay } from "./replay";
import type { Vendor } from "./scenario";
import type { BookEntry, Break, Diagnosis, Email, EmailClaims, Evidence, Pocket, Transfer } from "./types";

/** How far each kind of evidence is trusted. Fixed in code, never by the model. */
export const WEIGHT = {
  awxTerminal: 0.95,
  awxAmounts: 0.97,
  awxInFlight: 0.7,
  books: 0.6,
  email: 0.45,
  sla: 0.4,
} as const;

const noisyOr = (ws: number[]) => 1 - ws.reduce((p, w) => p * (1 - w), 1);

/** Support raises confidence; contradiction pulls it down by up to half. */
export const confidence = (support: number[], contra: number[] = []) =>
  r2(noisyOr(support) * (1 - 0.5 * noisyOr(contra)));

export function buildEvidence(g: Ground, books: BookEntry[], emails: Email[], claims: EmailClaims[], sentOn: Record<string, string>): Evidence[] {
  const ev: Evidence[] = [];
  for (const t of g.transfers) {
    const terminal = t.status === "CANCELLED";
    const path = t.history.map((h) => h.status).join(" → ");
    ev.push({
      id: `ev:${t.id}`,
      source: "airwallex",
      weight: terminal ? WEIGHT.awxTerminal : WEIGHT.awxInFlight,
      summary: `Transfer ${t.short_reference_id} for ${t.metadata.invoice}: ${fmt(t.transfer_amount, t.transfer_currency)} ${t.transfer_method}, fee ${fmt(t.fee_amount, t.fee_currency)}, ${path}${t.failure_reason ? `, failure ${t.failure_reason}` : ""}`,
      at: sentOn[t.metadata.invoice] ?? t.created_at,
      touches: [t.id, t.metadata.invoice],
      raw: { id: t.id, request_id: t.request_id, status: t.status, failure_type: t.failure_type },
    });
  }
  for (const c of g.conversions) {
    ev.push({
      id: `ev:${c.id}`,
      source: "airwallex",
      weight: WEIGHT.awxAmounts,
      summary: `Conversion for ${c.metadata.plan ?? "top-up"}: bought ${fmt(c.buy_amount, c.buy_currency)} for ${fmt(c.sell_amount, c.sell_currency)} at ${c.client_rate}`,
      at: c.created_at,
      touches: [c.id, c.metadata.plan ?? ""],
      raw: { id: c.id, request_id: c.request_id },
    });
  }
  for (const d of g.deposits) {
    ev.push({
      id: `ev:${d.id}`,
      source: "airwallex",
      weight: WEIGHT.awxAmounts,
      summary: `Deposit of ${fmt(d.amount, d.currency)} from "${d.payer_name}"`,
      at: d.created_at,
      touches: [d.id],
      raw: { id: d.id },
    });
  }
  for (const b of books) {
    ev.push({
      id: `ev:${b.id}`,
      source: "books",
      weight: WEIGHT.books,
      summary: `${b.id} ${b.kind} ${fmt(b.amount, b.currency)} ${b.counterparty}, due ${b.due}, booked ${b.booked}`,
      at: b.due,
      touches: [b.id],
    });
  }
  for (const e of emails) {
    const c = claims.find((x) => x.emailId === e.id);
    ev.push({
      id: `ev:${e.id}`,
      source: "email",
      weight: WEIGHT.email,
      summary: c ? `${e.from}: ${c.claim.replace(/_/g, " ")} (${c.invoiceRefs.join(", ")}). "${c.quote}"` : `${e.from}: ${e.subject}`,
      at: e.receivedAt,
      touches: [e.id, ...(c?.invoiceRefs ?? [])],
    });
  }
  return ev;
}

export interface DiagnoseInput {
  breaks: Break[];
  ground: Ground;
  books: BookEntry[];
  claims: EmailClaims[];
  vendors: Vendor[];
  pockets: Pocket[];
  auditDate: string;
  sentOn: Record<string, string>;
}

const sameAccount = (a?: string, b?: string) => !!a && !!b && a.replace(/\s/g, "") === b.replace(/\s/g, "");
const LIVE = ["PROCESSING", "SENT", "PAID"];

type Ruled = Diagnosis["ruledOut"];
/** Keeps a theory only when the fact that rules it out actually holds. */
const ruleOut = (...items: [holds: boolean, theory: string, why: string, evidenceId: string][]): Ruled =>
  items.filter(([holds]) => holds).map(([, theory, why, evidenceId]) => ({ theory, why, evidenceId }));

/**
 * Work out why each break happened. Causes the API states outright are read,
 * not guessed. Arithmetic causes are proven by replaying the pocket with one
 * event changed. Only the ambiguous ones get a confidence below 0.9.
 */
export function diagnose(input: DiagnoseInput): Diagnosis[] {
  const { breaks, ground, books, claims, vendors, pockets, auditDate, sentOn } = input;
  const moves = movementsFrom(ground);
  const tById = new Map(ground.transfers.map((t) => [t.id, t]));
  const entry = (id: string) => books.find((b) => b.id === id)!;
  const out: Diagnosis[] = [];

  for (const b of breaks) {
    switch (b.kind) {
      case "DUPLICATE_PAYMENT": {
        const [first, ...dups] = b.objectIds.map((id) => tById.get(id)!) as Transfer[];
        const pocket = pockets.find((p) => p.currency === b.currency)!;
        const actual = replay(moves, b.currency, 0, pocket.reserveFloor);
        const without = replay(intervene(moves, { drop: (m) => dups.some((d) => m.sourceId === d.id) }), b.currency, 0, pocket.reserveFloor);
        const gap = Math.round((Date.parse(dups[0].created_at) - Date.parse(first.created_at)) / 60_000);
        out.push({
          breakId: b.id,
          cause: "MANUAL_RESUBMISSION",
          causeLabel: "Same invoice submitted twice under two request_ids",
          chain: [
            { fact: `${first.short_reference_id} and ${dups[0].short_reference_id} pay the same beneficiary ${fmt(first.transfer_amount, first.transfer_currency)} for ${first.metadata.invoice}`, evidenceId: `ev:${first.id}` },
            { fact: `They carry different request_ids (${first.request_id.slice(0, 8)}…, ${dups[0].request_id.slice(0, 8)}…), so Airwallex treated them as two payments`, evidenceId: `ev:${dups[0].id}` },
            { fact: `The second was created ${Math.max(gap, 1)} min after the first and neither request_id came from a duplicate lock`, evidenceId: `ev:${dups[0].id}` },
            { fact: `Both are still ${dups[0].status}: the duplicate can be stopped before it leaves`, evidenceId: `ev:${dups[0].id}` },
          ],
          ruledOut: ruleOut(
            [first.metadata.invoice === dups[0].metadata.invoice && first.beneficiary_id === dups[0].beneficiary_id,
              "Two invoices that happen to match", `Both carry ${first.metadata.invoice} and pay the same beneficiary`, `ev:${dups[0].id}`],
            [first.request_id !== dups[0].request_id,
              "An automatic retry", "A retry reuses its request_id. These two have different ones", `ev:${dups[0].id}`],
          ),
          confidence: confidence([WEIGHT.awxAmounts, WEIGHT.awxInFlight, WEIGHT.books]),
          counterfactual: {
            question: `Had a duplicate lock guarded ${first.metadata.invoice}, would the ${b.currency} pocket have held its reserve floor?`,
            intervention: `Drop ${dups[0].short_reference_id} from the replay; keep every other movement as Airwallex reported it`,
            actual: { label: "Lowest balance, as it happened", value: fmt(actual.min, b.currency) },
            replayed: { label: "Lowest balance, with the lock", value: fmt(without.min, b.currency) },
            wouldHaveCleared: !without.breachAt,
          },
          explanation: `Someone re-sent ${first.metadata.invoice} instead of checking the first transfer, and Airwallex accepted it because the request_id was new. The second payment is still ${dups[0].status}, so it can be cancelled before money leaves.`,
          explainedBy: "rules",
        });
        break;
      }

      case "RETURNED_AFTER_BOOKED_PAID": {
        const t = tById.get(b.objectIds.at(-1)!)!;
        const e = entry(b.entryIds[0]);
        const path = t.history.map((h) => h.status);
        const latePaid = path.includes("PAID");
        const closed = t.failure_type === "ACCOUNT_CLOSED" || t.failure_type === "ACCOUNT_INACTIVE_OR_DORMANT";
        const claim = claims.find((c) => c.invoiceRefs.includes(e.id) && c.confirmsBankDetails);
        const vendor = vendors.find((v) => v.name === e.counterparty);
        const detailsConfirmed = !!claim && sameAccount(claim.quotedAccount, vendor?.account);
        const chain = [
          { fact: `${t.short_reference_id} went ${path.join(" → ")}`, evidenceId: `ev:${t.id}` },
          latePaid
            ? { fact: `The books closed ${e.id} at PAID, but PAID is not final: the receiving bank rejected it afterwards`, evidenceId: `ev:${t.id}` }
            : { fact: `The books closed ${e.id} when the transfer was sent, before it settled`, evidenceId: `ev:${e.id}` },
          { fact: `Failure reason ${t.failure_reason}; ${fmt(t.transfer_amount, t.transfer_currency)} came back to the wallet, the ${fmt(t.fee_amount, t.fee_currency)} fee did not`, evidenceId: `ev:${t.id}` },
        ];
        if (detailsConfirmed) chain.push({ fact: `The supplier confirmed in writing that the account on file is correct`, evidenceId: `ev:${claim!.emailId}` });
        out.push({
          breakId: b.id,
          cause: closed ? "BANK_RETURN_ACCOUNT_CLOSED" : "BANK_RETURN",
          causeLabel: closed ? "Beneficiary account closed" : "Returned by the beneficiary's bank",
          chain,
          ruledOut: ruleOut(
            [t.status === "FAILED" || t.status === "CANCELLED", "Still on its way", `Airwallex reports ${t.status}, which is final`, `ev:${t.id}`],
            [closed, "A typo in the account details", `The failure is ${t.failure_reason}, not an invalid account number`, `ev:${t.id}`],
            [!closed, "The account was closed", `The failure is ${t.failure_reason}, not an account closure`, `ev:${t.id}`],
            [!closed && detailsConfirmed, "Wrong details on file", `${e.counterparty} confirmed the account on file in writing`, `ev:${claim?.emailId}`],
          ),
          confidence: confidence([WEIGHT.awxTerminal, WEIGHT.awxAmounts], closed || detailsConfirmed ? [] : [WEIGHT.sla]),
          counterfactual: {
            question: `Would a replacement to the same account clear?`,
            intervention: `Re-run ${t.short_reference_id} unchanged against the failure it hit`,
            actual: { label: "Original", value: `${t.status}, ${t.failure_reason}` },
            replayed: closed
              ? { label: "Replacement", value: "Fails again: the account itself is closed" }
              : detailsConfirmed
                ? { label: "Replacement", value: "Likely clears: details confirmed, return was not about the account" }
                : { label: "Replacement", value: "Unknown until the supplier confirms details" },
            wouldHaveCleared: !closed && detailsConfirmed,
          },
          explanation: closed
            ? `${e.counterparty}'s bank account is closed, so the payment came back. Sending it again to the same account would fail the same way. The supplier is still unpaid, and the books wrongly show ${e.id} as settled.`
            : `${e.counterparty}'s bank returned the payment. ${detailsConfirmed ? "The supplier has confirmed the account details, so a single replacement is reasonable." : "The details need confirming before a replacement."}`,
          explainedBy: "rules",
        });
        break;
      }

      case "FEE_NOT_FUNDED": {
        const plan = books.find((x) => x.kind === "fx_plan" && x.currency === b.currency);
        const feeTs = b.objectIds.map((id) => tById.get(id)!);
        // Fees come off the transfers themselves: the sandbox and the mock charge different amounts.
        const total = r2(feeTs.reduce((s, t) => s + t.fee_amount, 0));
        const flat = feeTs.every((t) => t.fee_amount === feeTs[0].fee_amount) ? feeTs[0].fee_amount : undefined;
        const scheme = schemesOf(feeTs);
        const plural = feeTs.length > 1 ? "s" : "";
        const took =
          flat !== undefined
            ? `${feeTs.length} ${scheme} payout${plural} each took a flat ${fmt(flat, b.currency)} from the same wallet`
            : `${feeTs.length} ${scheme} payout${plural} took ${fmt(total, b.currency)} in fees from the same wallet`;
        const actual = replay(moves, b.currency, 0, 0);
        const conv = ground.conversions.find((c) => c.metadata.plan === plan?.id);
        const pocketTs = ground.transfers.filter((t) => t.transfer_currency === b.currency);
        const invoices = [...new Set(pocketTs.map((t) => t.metadata.invoice))];
        const liveCount = (inv: string) => pocketTs.filter((t) => t.metadata.invoice === inv && LIVE.includes(t.status)).length;
        const bounced = pocketTs.filter((t) => t.status === "FAILED" || t.history.some((h) => h.status === "FAILED"));
        const ruled = ruleOut(
          [Math.abs(-b.variance - total) < 0.005,
            "A bank error", `Every movement ties to an Airwallex object, and the gap is exactly ${flat !== undefined ? `${feeTs.length} × ${fmt(flat, b.currency)}` : `the ${fmt(total, b.currency)} of fees`}`, `ev:${feeTs[0].id}`],
          [invoices.length > 0 && invoices.every((inv) => liveCount(inv) <= 1),
            "A supplier paid twice", `${invoices.join(" and ")} ${invoices.length > 1 ? "each have" : "has"} one payment`, `ev:${feeTs[0].id}`],
          [!!conv && !!plan && conv.buy_amount === plan.amount,
            "The exchange rate moved", `${plan?.id} bought exactly ${fmt(conv?.buy_amount ?? 0, b.currency)}. A rate move changes the cost in USD, not the amount that arrives`, `ev:${conv?.id}`],
          [bounced.length === 0,
            "A payout bounced", `No ${b.currency} payout has failed or come back`, `ev:${feeTs[0].id}`],
        );

        if (!plan || !conv) {
          // The funding pocket: nothing was converted into it, so the fees were simply never booked.
          out.push({
            breakId: b.id,
            cause: "PAYOUT_FEE_NOT_BOOKED",
            causeLabel: "Payout fees were taken but never booked",
            chain: [
              { fact: took, evidenceId: `ev:${feeTs[0].id}` },
              { fact: `Nothing in the books records those fees, so the pocket runs ${fmt(-b.variance, b.currency)} below what the books say`, evidenceId: `ev:${feeTs[0].id}` },
            ],
            ruledOut: ruled,
            confidence: confidence([WEIGHT.awxAmounts, WEIGHT.awxAmounts]),
            explanation: `Each ${scheme} payout from the ${b.currency} pocket carries a fee that the books never recorded. The pocket is short by exactly those fees, ${fmt(total, b.currency)}.`,
            explainedBy: "rules",
          });
          break;
        }

        const fixed = replay(
          intervene(moves, {
            adjust: (m) => (m.sourceId === conv.id && m.kind === "CONVERSION_BUY" ? { ...m, amount: r2(m.amount + -b.variance) } : m),
          }),
          b.currency,
          0,
          0,
        );
        out.push({
          breakId: b.id,
          cause: "SWIFT_FEE_NOT_IN_FUNDING",
          causeLabel: "Conversion bought the invoice total, not invoice plus fees",
          chain: [
            { fact: `${plan.id} bought exactly ${fmt(conv.buy_amount, b.currency)}, the sum of the invoices it funded`, evidenceId: `ev:${conv.id}` },
            { fact: took, evidenceId: `ev:${feeTs[0].id}` },
            { fact: `Nothing in the books records those fees, so the pocket runs ${fmt(-b.variance, b.currency)} below what the books say`, evidenceId: `ev:${plan.id}` },
          ],
          ruledOut: ruled,
          confidence: confidence([WEIGHT.awxAmounts, WEIGHT.awxAmounts]),
          counterfactual: {
            question: `Had the ${scheme} fees been included in ${plan.id}, would the ${b.currency} pocket have cleared?`,
            intervention: `Buy ${fmt(-b.variance, b.currency)} more in ${plan.id}; replay every payout as it happened`,
            actual: { label: "Lowest balance, as it happened", value: fmt(actual.min, b.currency) },
            replayed: { label: "Lowest balance, fee-aware", value: fmt(fixed.min, b.currency) },
            wouldHaveCleared: fixed.min >= -0.004,
          },
          explanation: `The ${b.currency} batch was funded with the invoice total, but each ${scheme} payout also takes ${flat !== undefined ? `a ${fmt(flat, b.currency)} fee` : "a fee"} from the same wallet. The pocket is short by exactly the fees. Funding fee-aware would have left it at zero.`,
          explainedBy: "rules",
        });
        break;
      }

      case "IN_FLIGHT_DISPUTED": {
        const t = tById.get(b.objectIds[0])!;
        const e = entry(b.entryIds[0]);
        const claim = claims.find((c) => c.claim === "payment_not_received" && c.invoiceRefs.includes(e.id))!;
        const age = days(sentOn[e.id] ?? t.created_at, auditDate);
        const pastSla = age > 5;
        out.push({
          breakId: b.id,
          cause: "STILL_IN_FLIGHT",
          causeLabel: "Sent and not yet settled; no failure reported",
          chain: [
            { fact: `${t.short_reference_id} is SENT, not PAID and not FAILED. Airwallex has reported no return`, evidenceId: `ev:${t.id}` },
            { fact: `It left ${age} days ago. SWIFT usually settles in 1 to 5 business days${pastSla ? ", so this is past the usual window" : ""}`, evidenceId: `ev:${t.id}` },
            { fact: `${e.counterparty} says nothing has arrived: "${claim.quote}"`, evidenceId: `ev:${claim.emailId}` },
            { fact: `Replacing it now would leave two live payments for one invoice`, evidenceId: `ev:${e.id}` },
          ],
          ruledOut: ruleOut(
            [t.status === "SENT" && !t.failure_reason, "The payment failed", `Airwallex shows ${t.short_reference_id} as SENT, with no failure and no return`, `ev:${t.id}`],
            [true, "It was never sent", `Airwallex accepted it ${age} days ago as ${t.short_reference_id}`, `ev:${t.id}`],
          ),
          confidence: confidence([WEIGHT.awxInFlight], [WEIGHT.email, ...(pastSla ? [WEIGHT.sla] : [])]),
          counterfactual: {
            question: `If we replace ${e.id} now and the original still lands, what leaves the wallet?`,
            intervention: `Add a second ${fmt(t.transfer_amount, t.transfer_currency)} SWIFT payout and let the original settle`,
            actual: { label: "Paid out if we wait", value: fmt(t.transfer_amount + t.fee_amount, t.transfer_currency) },
            replayed: { label: "Paid out if we replace now", value: fmt(2 * (t.transfer_amount + t.fee_amount), t.transfer_currency) },
            wouldHaveCleared: false,
          },
          explanation: `The transfer has left Airwallex and has not failed, so it is most likely still moving through correspondent banks. The supplier's email conflicts with that, which is why confidence is low. Paying again now risks paying twice, so the agent waits and asks for a trace.`,
          explainedBy: "rules",
        });
        break;
      }

      case "RECEIPT_MISSING": {
        const e = entry(b.entryIds[0]);
        const late = days(e.due, auditDate);
        const claim = claims.find((c) => c.invoiceRefs.includes(e.id));
        out.push({
          breakId: b.id,
          cause: "CUSTOMER_LATE",
          causeLabel: "Customer has not paid yet",
          chain: [
            { fact: `${e.id} for ${fmt(e.amount, e.currency)} was due ${e.due}, ${late} days before this audit`, evidenceId: `ev:${e.id}` },
            { fact: `No deposit from ${e.counterparty} near that amount has reached the wallet`, evidenceId: `ev:${e.id}` },
            ...(claim ? [{ fact: `${e.counterparty} wrote: "${claim.quote}"`, evidenceId: `ev:${claim.emailId}` }] : []),
          ],
          ruledOut: ruleOut(
            [ground.deposits.every((d) => Math.abs(d.amount - e.amount) > e.amount * 0.05),
              "It arrived under another name", `No deposit within 5% of ${fmt(e.amount, e.currency)} has come in from any payer`, `ev:${e.id}`],
          ),
          confidence: confidence([WEIGHT.books, WEIGHT.awxAmounts * 0.6]),
          explanation: `${e.counterparty} is ${late} days late and nothing has arrived. Any payment that was counting on this cash should wait until it lands.`,
          explainedBy: "rules",
        });
        break;
      }

      case "RECEIPT_SHORT": {
        const e = entry(b.entryIds[0]);
        const d = ground.deposits.find((x) => x.id === b.objectIds[0])!;
        const short = -b.variance;
        const partialClaim = claims.find((c) => c.invoiceRefs.includes(e.id) && c.claim === "will_pay_partial_later");
        const bankCharge = short <= 50 && !partialClaim;
        out.push({
          breakId: b.id,
          cause: bankCharge ? "PAYER_BANK_CHARGE" : "PARTIAL_PAYMENT",
          causeLabel: bankCharge ? "Intermediary bank charge deducted in transit" : "Customer paid part of the invoice",
          chain: [
            { fact: `Deposit "${d.payer_name}" of ${fmt(d.amount, d.currency)} matches ${e.id} by payer and reference`, evidenceId: `ev:${d.id}` },
            { fact: `It is ${fmt(short, e.currency)} short of the ${fmt(e.amount, e.currency)} invoiced`, evidenceId: `ev:${e.id}` },
            bankCharge
              ? { fact: `A shortfall of ${fmt(short, e.currency)} is within the usual range of a wire charge, and the customer has not said it is paying less`, evidenceId: `ev:${d.id}` }
              : { fact: `The customer said it would pay part now`, evidenceId: `ev:${partialClaim?.emailId ?? d.id}` },
          ],
          ruledOut: ruleOut(
            [true, "Matched to the wrong invoice", `Payer and reference both match ${e.id}`, `ev:${d.id}`],
            [bankCharge, "The customer short-paid on purpose", `${e.counterparty} has not written about paying less`, `ev:${e.id}`],
            [!bankCharge && short > 50, "A bank charge", `${fmt(short, e.currency)} is over the ${fmt(50, e.currency)} a wire charge usually takes`, `ev:${d.id}`],
          ),
          confidence: bankCharge ? confidence([WEIGHT.awxAmounts, WEIGHT.books], [0.2]) : confidence([WEIGHT.awxAmounts, WEIGHT.email]),
          explanation: bankCharge
            ? `${e.counterparty} paid in full, but a bank on the way took ${fmt(short, e.currency)}. Write it off as a bank charge; it is under the ${fmt(50, e.currency)} tolerance.`
            : `${e.counterparty} paid part of ${e.id}. Keep the rest open as a receivable.`,
          explainedBy: "rules",
        });
        break;
      }

      case "FX_RATE_VARIANCE": {
        const e = entry(b.entryIds[0]);
        const c = ground.conversions.find((x) => x.id === b.objectIds[0])!;
        const rateGap = e.plannedRate ? r2(Math.abs(e.amount / e.plannedRate - c.sell_amount)) : NaN;
        out.push({
          breakId: b.id,
          cause: "RATE_MOVED_SINCE_PLAN",
          causeLabel: "Booked at the plan's rate, converted at the market rate",
          chain: [
            { fact: `The books costed ${e.id} at the treasury plan's rate of ${e.plannedRate} ${e.currency} per ${c.sell_currency}`, evidenceId: `ev:${e.id}` },
            { fact: `Airwallex converted at ${c.client_rate}: ${fmt(c.buy_amount, c.buy_currency)} cost ${fmt(c.sell_amount, c.sell_currency)}`, evidenceId: `ev:${c.id}` },
            { fact: `The difference, ${fmt(b.variance, b.currency)}, is an unbooked FX ${b.variance > 0 ? "gain" : "loss"}, not missing money`, evidenceId: `ev:${c.id}` },
          ],
          ruledOut: ruleOut(
            [c.status === "SETTLED", "Money went missing", `${fmt(c.buy_amount, c.buy_currency)} arrived in full for ${fmt(c.sell_amount, c.sell_currency)}`, `ev:${c.id}`],
            [Math.abs(rateGap - Math.abs(b.variance)) < 0.02, "A hidden conversion fee", `The gap is exactly the rate difference on ${fmt(e.amount, e.currency)}, to the cent`, `ev:${c.id}`],
          ),
          confidence: confidence([WEIGHT.awxAmounts, WEIGHT.books]),
          explanation: `Nothing went wrong with the money. The rate moved between the plan and the booking, and the books never recorded the ${b.variance > 0 ? "gain" : "loss"}.`,
          explainedBy: "rules",
        });
        break;
      }
    }
  }
  return out;
}
