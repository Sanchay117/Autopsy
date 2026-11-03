import { fmt, r2, swiftFeeFrom, toUsd, type UsdRates } from "./money";
import { autonomyLimitUsd, bindingHash, POLICY } from "./policy";
import { confidence, WEIGHT } from "./diagnose";
import type { Vendor } from "./scenario";
import type {
  ActionKind,
  ActionOption,
  BookEntry,
  Break,
  Currency,
  Decision,
  Diagnosis,
  EmailClaims,
  Rule,
  Transfer,
} from "./types";

export interface DecideInput {
  breaks: Break[];
  diagnoses: Diagnosis[];
  books: BookEntry[];
  transfers: Transfer[];
  vendors: Vendor[];
  claims: EmailClaims[];
  /** Bank-side pocket balances right now. */
  balances: Record<Currency, number>;
  floors: Record<Currency, number>;
  rates: UsdRates;
  rules: Rule[];
  metalEnabled: boolean;
  auditDate: string;
  /** Decisions already carried out, so obligations are not decided twice. */
  executedKeys: Set<string>;
}

const MONEY_OUT: ActionKind[] = ["REPLACE", "PAY", "CONVERT", "TOP_UP"];

/** Forecast confidence for a receivable, from history and anything the customer said. */
export function forecastConfidence(entry: BookEntry, claims: EmailClaims[]) {
  const said = claims.find(
    (c) => c.invoiceRefs.includes(entry.id) && (c.claim === "will_pay_partial_later" || c.claim === "disputes_invoice"),
  );
  // A customer telling you it will pay late outweighs its history.
  return { value: confidence([WEIGHT.books, 0.75], said ? [0.9] : []), said };
}

/**
 * Score every policy-valid option for each break by expected cost plus risk
 * times exposure, and pick the cheapest. Options that break a rule stay on the
 * card with the reason they were refused.
 */
export function decide(input: DecideInput): Decision[] {
  const { breaks, diagnoses, books, transfers, vendors, claims, rates, rules, auditDate } = input;
  const projected = { ...input.balances };
  const decisions: Decision[] = [];
  const entry = (id: string) => books.find((b) => b.id === id)!;
  const usd = (a: number, c: Currency) => toUsd(a, c, rates);
  const hasRule = (id: string) => rules.some((r) => r.id === id);
  const swiftFee = (c: Currency) => swiftFeeFrom(transfers, c);

  const opt = (
    kind: ActionKind,
    rail: ActionOption["rail"],
    label: string,
    amount: number,
    currency: Currency,
    counterparty: string,
    expectedCostUsd: number,
    risk: number,
    etaHours: number,
    blockedBy?: string,
  ): ActionOption => ({
    kind, rail, label, amount: r2(amount), currency, amountUsd: usd(amount, currency), counterparty,
    expectedCostUsd: r2(expectedCostUsd), risk, etaHours, blockedBy,
  });

  const floorCheck = (o: ActionOption) => {
    if (!MONEY_OUT.includes(o.kind) || o.rail === "metal" || o.blockedBy) return o;
    const sellCur: Currency = o.kind === "CONVERT" || o.kind === "TOP_UP" ? "USD" : o.currency;
    const out = o.kind === "CONVERT" || o.kind === "TOP_UP" ? o.amountUsd : o.amount;
    const after = r2(projected[sellCur] - out);
    if (after < input.floors[sellCur]) {
      return { ...o, blockedBy: `Would leave the ${sellCur} pocket at ${fmt(after, sellCur)}, under its ${fmt(input.floors[sellCur], sellCur)} reserve floor` };
    }
    return o;
  };

  const choose = (
    key: string,
    breakId: string,
    options: ActionOption[],
    exposureUsd: number,
    conf: number,
    dependsOn: string[],
    extra: Partial<Decision> = {},
  ) => {
    const checked = options.map(floorCheck);
    const score = (o: ActionOption) => o.expectedCostUsd + o.risk * exposureUsd;
    const allowed = checked.filter((o) => !o.blockedBy).sort((a, b) => score(a) - score(b));
    const chosen = allowed[0] ?? checked.find((o) => o.kind === "ESCALATE")!;
    const limit = autonomyLimitUsd(conf);
    const moneyOut = MONEY_OUT.includes(chosen.kind) && chosen.rail !== "books";
    let approvalReason: string | undefined;
    if (POLICY.alwaysHuman.includes(chosen.kind)) approvalReason = `${chosen.kind.replace("_", " ").toLowerCase()} always goes to a person`;
    else if (chosen.kind === "REPLACE") approvalReason = "a second payment for the same invoice always goes to a person";
    else if (moneyOut && chosen.amountUsd > limit)
      approvalReason = `${fmt(chosen.amountUsd, "USD")} is over the ${fmt(limit, "USD")} autonomy limit at confidence ${conf.toFixed(2)}`;
    else if (!moneyOut && conf < 0.5 && !["WAIT", "CHASE", "DEFER"].includes(chosen.kind))
      approvalReason = `confidence ${conf.toFixed(2)} is below 0.50`;

    if (moneyOut && !approvalReason && !extra.executeOn) {
      const sellCur: Currency = chosen.kind === "CONVERT" || chosen.kind === "TOP_UP" ? "USD" : chosen.currency;
      if (chosen.rail === "airwallex") projected[sellCur] = r2(projected[sellCur] - (sellCur === "USD" && chosen.currency !== "USD" ? chosen.amountUsd : chosen.amount));
    }

    const vendor = vendors.find((v) => v.name === chosen.counterparty);
    const terms: Record<string, string | number> = {
      action: chosen.kind,
      rail: chosen.rail,
      amount: chosen.amount,
      currency: chosen.currency,
      counterparty: chosen.counterparty,
      account: chosen.rail === "metal" ? vendor?.metalAddress ?? "" : vendor?.account ?? "",
      evidence: dependsOn.filter((d) => d.startsWith("ev:")).sort().join(","),
      policy: POLICY.version,
    };
    decisions.push({
      id: `DEC-${key}`,
      breakId,
      chosen,
      rejected: checked
        .filter((o) => o !== chosen)
        .map((o) => ({ ...o, why: o.blockedBy ?? `Expected cost ${fmt(score(o), "USD")} vs ${fmt(score(chosen), "USD")}` })),
      autonomyLimitUsd: limit,
      needsApproval: !!approvalReason,
      approvalReason,
      binding: bindingHash(terms),
      bindingTerms: terms,
      dependsOn,
      confidence: conf,
      status: approvalReason ? "awaiting_approval" : extra.executeOn ? "scheduled" : "proposed",
      revision: 1,
      ...extra,
    });
  };

  // Risk-reducing actions first, so later choices see the cash they free up.
  const order: Break["kind"][] = [
    "DUPLICATE_PAYMENT", "FEE_NOT_FUNDED", "FX_RATE_VARIANCE", "RECEIPT_SHORT",
    "RETURNED_AFTER_BOOKED_PAID", "IN_FLIGHT_DISPUTED", "RECEIPT_MISSING",
  ];
  const sorted = [...breaks].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));

  for (const b of sorted) {
    const d = diagnoses.find((x) => x.breakId === b.id);
    if (!d) continue;
    const deps = [...b.objectIds, ...b.entryIds, ...b.evidenceIds, `pocket:${b.currency}`];
    const e = b.entryIds[0] ? entry(b.entryIds[0]) : undefined;
    const name = e?.counterparty ?? "";

    switch (d.cause) {
      case "MANUAL_RESUBMISSION": {
        const amt = -b.variance;
        projected[b.currency] = r2(projected[b.currency] + amt); // cancelling returns it
        choose(b.id, b.id, [
          opt("CANCEL_DUPLICATE", "airwallex", `Cancel the second transfer before it leaves`, amt, b.currency, name, 0, 0.02, 0),
          opt("ESCALATE", "books", `Hand to AP to recall`, amt, b.currency, name, POLICY.opsCostUsd, 0.25, 8),
          opt("WAIT", "books", `Leave both and ask the supplier to refund one`, amt, b.currency, name, POLICY.opsCostUsd * 2, 0.6, 72),
        ], b.exposureUsd, d.confidence, deps);
        break;
      }
      case "SWIFT_FEE_NOT_IN_FUNDING": {
        const amt = -b.variance;
        choose(b.id, b.id, [
          opt("TOP_UP", "airwallex", `Convert the ${fmt(amt, b.currency)} shortfall and book the fees`, amt, b.currency, "Airwallex FX", usd(amt, b.currency) * 0.004, 0.01, 0),
          opt("WAIT", "books", `Leave the pocket short until the next funding run`, amt, b.currency, "Airwallex FX", 0, 0.5, 168),
          opt("ESCALATE", "books", `Ask treasury to fund it`, amt, b.currency, "Airwallex FX", POLICY.opsCostUsd, 0.05, 24),
        ], usd(amt, b.currency) * 10, d.confidence, deps);
        break;
      }
      case "PAYOUT_FEE_NOT_BOOKED": {
        const amt = -b.variance;
        choose(b.id, b.id, [
          opt("POST_ADJUSTMENT", "books", `Book the ${fmt(amt, b.currency)} of payout fees`, amt, b.currency, "General ledger", 0, 0, 0),
          opt("ESCALATE", "books", `Ask the controller to review`, amt, b.currency, "General ledger", POLICY.opsCostUsd, 0, 24),
        ], 0, d.confidence, deps);
        break;
      }
      case "RATE_MOVED_SINCE_PLAN":
        choose(b.id, b.id, [
          opt("POST_ADJUSTMENT", "books", `Book the FX ${b.variance > 0 ? "gain" : "loss"} of ${fmt(Math.abs(b.variance), b.currency)}`, Math.abs(b.variance), b.currency, "General ledger", 0, 0, 0),
          opt("ESCALATE", "books", `Ask the controller to review`, Math.abs(b.variance), b.currency, "General ledger", POLICY.opsCostUsd, 0, 24),
        ], 0, d.confidence, deps);
        break;
      case "PAYER_BANK_CHARGE":
        choose(b.id, b.id, [
          opt("POST_ADJUSTMENT", "books", `Write off ${fmt(-b.variance, b.currency)} as a bank charge`, -b.variance, b.currency, name, 0, 0.02, 0,
            usd(-b.variance, b.currency) > POLICY.bankChargeToleranceUsd ? "Over the bank-charge tolerance" : undefined),
          opt("CHASE", "books", `Ask ${name} for the shortfall`, -b.variance, b.currency, name, POLICY.opsCostUsd, 0.3, 120),
        ], usd(-b.variance, b.currency), d.confidence, deps);
        break;
      case "PARTIAL_PAYMENT":
        choose(b.id, b.id, [
          opt("CHASE", "books", `Keep the balance open and confirm the date with ${name}`, -b.variance, b.currency, name, 0, 0.1, 0),
          opt("ESCALATE", "books", `Hand to credit control`, -b.variance, b.currency, name, POLICY.opsCostUsd, 0.05, 24),
        ], usd(-b.variance, b.currency), d.confidence, deps);
        break;
      case "STILL_IN_FLIGHT": {
        const t = transfers.find((x) => x.id === b.objectIds[0])!;
        const lock = `Duplicate lock: ${t.short_reference_id} is still ${t.status}, so a second payment for ${e!.id} is refused`;
        const vendor = vendors.find((v) => v.name === name);
        choose(b.id, b.id, [
          opt("WAIT", "books", `Wait 48 hours, request a SWIFT trace, tell ${name} it is in transit`, e!.amount, e!.currency, name, POLICY.lateCostUsdPerDay * 2, 0.05, 48),
          opt("REPLACE", "airwallex", `Send a replacement SWIFT now`, e!.amount, e!.currency, name, usd(swiftFee(e!.currency), e!.currency), 0.5, 48, lock),
          ...(input.metalEnabled && vendor?.metalAddress
            ? [opt("REPLACE", "metal", `Settle now on Metal to ${vendor.metalAddress.slice(0, 10)}…`, usd(e!.amount, e!.currency), "USD", name, 0.05, 0.5, 0.1, lock)]
            : []),
          opt("ESCALATE", "books", `Hand to AP without a recommendation`, e!.amount, e!.currency, name, POLICY.opsCostUsd + POLICY.lateCostUsdPerDay * 2, 0.15, 48),
        ], b.exposureUsd, d.confidence, deps);
        break;
      }
      case "BANK_RETURN_ACCOUNT_CLOSED":
      case "BANK_RETURN": {
        const closed = d.cause === "BANK_RETURN_ACCOUNT_CLOSED";
        const vendor = vendors.find((v) => v.name === name);
        const claim = claims.find((c) => c.invoiceRefs.includes(e!.id));
        const confirmed = !!d.counterfactual?.wouldHaveCleared;
        const metalOk = input.metalEnabled && !!vendor?.metalAddress && !!claim?.acceptsStablecoin;
        const metalAmt = usd(e!.amount, e!.currency);
        // The supplier is already past due, so every hour of delay has a price.
        const late = (hours: number) => (POLICY.lateCostUsdPerDay * hours) / 24;
        const swiftEta = e!.method === "SWIFT" ? 48 : 24;
        // Learned rule R-FEE: a SWIFT replacement must be funded with its fee.
        const feeNote = hasRule("R-FEE") && e!.method === "SWIFT" ? ` (fee-aware: funds the ${fmt(swiftFee(e!.currency), e!.currency)} fee first)` : "";
        choose(b.id, b.id, [
          opt("REQUEST_DETAILS", "books", `Reopen ${e!.id} and ask ${name} for new bank details`, e!.amount, e!.currency, name,
            POLICY.opsCostUsd + late(72), confirmed ? 0.1 : 0.05, 72),
          opt("REPLACE", "airwallex", `Replace via ${e!.method} to the account on file${feeNote}`, e!.amount, e!.currency, name,
            usd(e!.method === "SWIFT" ? swiftFee(e!.currency) : 0, e!.currency) + late(swiftEta), 0.1, swiftEta,
            closed ? "The account is closed: a replacement to it would fail the same way" : confirmed ? undefined : "Bank details not yet confirmed by the supplier"),
          ...(input.metalEnabled && vendor?.metalAddress
            ? [opt("REPLACE", "metal", `Settle now on Metal to the onboarding wallet ${vendor.metalAddress.slice(0, 10)}…`, metalAmt, "USD", name, 0.05 + late(0.1), 0.08, 0.1,
                closed ? "Supplier has not agreed to stablecoin settlement" : !metalOk ? "Supplier has not offered stablecoin settlement in writing"
                  : metalAmt > POLICY.metalMandateCapUsd ? "Over the Metal mandate cap" : undefined)]
            : []),
          opt("ESCALATE", "books", `Hand to AP without a recommendation`, e!.amount, e!.currency, name, POLICY.opsCostUsd + late(48), 0.15, 48),
        ], b.exposureUsd, d.confidence, deps);
        break;
      }
      case "CUSTOMER_LATE": {
        choose(b.id, b.id, [
          opt("CHASE", "books", `Draft a reminder to ${name} for ${e!.id}`, e!.amount, e!.currency, name, 0, 0.1, 0),
          opt("ESCALATE", "books", `Hand to credit control`, e!.amount, e!.currency, name, POLICY.opsCostUsd, 0.05, 24),
        ], 0, d.confidence, deps);
        break;
      }
    }
  }

  // Obligations due within a week: pay now, or wait for the cash that funds them.
  for (const o of books.filter((x) => x.kind === "payable" && x.booked === "open" && days(auditDate, x.due) <= 7)) {
    if (input.executedKeys.has(`OBL-${o.id}`)) continue;
    const funding = books.find((x) => x.kind === "receivable" && x.due <= o.due && breaks.some((b) => b.kind === "RECEIPT_MISSING" && b.entryIds.includes(x.id)));
    const vendor = vendors.find((v) => v.name === o.counterparty);
    const hold = rules.find((r) => r.id === `R-HOLD-${vendor?.id}`);
    choose(`OBL-${o.id}`, `OBL-${o.id}`, [
      opt("PAY", "airwallex", `Pay ${o.id} now via ${o.method}`, o.amount, o.currency, o.counterparty, 0, 0.01, 24, hold ? `Rule ${hold.id}: ${hold.text}` : undefined),
      opt("DEFER", "books", funding ? `Hold ${o.id} until ${funding.id} lands (due ${o.due})` : `Hold ${o.id} to its due date`, o.amount, o.currency, o.counterparty, POLICY.lateCostUsdPerDay * 0.5, 0.05, 72),
    ], usd(o.amount, o.currency) * 0.01, 0.97, [o.id, `pocket:${o.currency}`, ...(funding ? [funding.id] : [])]);
  }

  // Next week's EUR batch: fund it now, sized by what the agent has learned.
  const batch = books.filter((x) => x.kind === "payable" && x.booked === "open" && x.currency === "EUR");
  const forecast = books.find((x) => x.id === "AR-7790");
  if (batch.length && forecast && !input.executedKeys.has("PLAN-FXP-120")) {
    const total = batch.reduce((s, x) => s + x.amount, 0);
    const swift = batch.filter((x) => x.method === "SWIFT").length;
    const feeAware = r2(total + swift * swiftFee("EUR"));
    const fc = forecastConfidence(forecast, claims);
    const label = batch.map((x) => x.id).join(" + ");
    const opts = hasRule("R-FEE")
      ? [
          opt("CONVERT", "airwallex", `Buy ${fmt(feeAware, "EUR")} for ${label}: invoices plus ${swift} SWIFT fees (rule R-FEE)`, feeAware, "EUR", "Airwallex FX", usd(feeAware, "EUR") * 0.004, 0.02, 0),
          opt("CONVERT", "airwallex", `Buy ${fmt(total, "EUR")}, invoice total only`, total, "EUR", "Airwallex FX", usd(total, "EUR") * 0.004, 0.02, 0, `Rule R-FEE: SWIFT fees must be funded (learned from BRK-FEE-EUR)`),
        ]
      : [opt("CONVERT", "airwallex", `Buy ${fmt(total, "EUR")} for ${label}`, total, "EUR", "Airwallex FX", usd(total, "EUR") * 0.004, 0.02, 0)];
    opts.push(opt("DEFER", "books", `Wait for ${forecast.id} before converting`, total, "EUR", "Airwallex FX", 30, 0.05, 96));
    choose("PLAN-FXP-120", "PLAN-FXP-120", opts, 0, fc.value,
      [...batch.map((x) => x.id), forecast.id, "pocket:USD", ...(fc.said ? [`ev:${fc.said.emailId}`] : [])],
      { executeOn: "2026-11-10" });
  }

  return decisions;
}

function days(from: string, to: string) {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
}
