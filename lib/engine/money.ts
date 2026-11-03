import type { Currency } from "./types";

export const r2 = (n: number) => Math.round(n * 100) / 100;

/** Flat SWIFT fee the sandbox charges per EUR payout. LOCAL payouts are free. */
export const SWIFT_FEE: Record<Currency, number> = { EUR: 12.85, USD: 15, GBP: 10 };

/** The SWIFT fee the bank last charged in `c`, or the flat one before any payout has shown it. */
export const swiftFeeFrom = (ts: { transfer_method: string; fee_currency: Currency; fee_amount: number }[], c: Currency) =>
  ts.filter((t) => t.transfer_method === "SWIFT" && t.fee_currency === c && t.fee_amount > 0).at(-1)?.fee_amount ?? SWIFT_FEE[c];

/** The scheme a payout used, for labels: SWIFT, or the local scheme for its currency. */
const LOCAL_SCHEME: Record<Currency, string> = { EUR: "SEPA", USD: "ACH", GBP: "Faster Payments" };
export const schemesOf = (ts: { transfer_method: string; transfer_currency: Currency }[]) =>
  [...new Set(ts.map((t) => (t.transfer_method === "SWIFT" ? "SWIFT" : LOCAL_SCHEME[t.transfer_currency])))].join(" and ");

/** USD per one unit of each currency, for comparing variances across pockets. */
export type UsdRates = Record<Currency, number>;

export const toUsd = (amount: number, currency: Currency, rates: UsdRates) =>
  r2(amount * rates[currency]);

export function fmt(amount: number, currency: Currency) {
  const sign = amount < 0 ? "-" : "";
  const abs = Math.abs(amount).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${sign}${currency} ${abs}`;
}
