import type { Vendor } from "./scenario";
import type { BookEntry, Break, Diagnosis, Rule } from "./types";

/**
 * Turn a confirmed cause into a standing rule, so the same break cannot come
 * back. Rules only ever add caution: they block options, never unblock them.
 */
export function learn(breaks: Break[], diagnoses: Diagnosis[], books: BookEntry[], rules: Rule[], vendors: Vendor[]): Rule[] {
  const fresh: Rule[] = [];
  const has = (id: string) => rules.some((r) => r.id === id) || fresh.some((r) => r.id === id);

  for (const d of diagnoses) {
    if (d.confidence < 0.9) continue;
    const b = breaks.find((x) => x.id === d.breakId);
    if (!b) continue;

    if (d.cause === "SWIFT_FEE_NOT_IN_FUNDING" && !has("R-FEE")) {
      fresh.push({
        id: "R-FEE",
        learnedFrom: b.id,
        text: "Fund every SWIFT payout with its fee: buy the invoice total plus the flat fee per transfer, never the invoice total alone.",
        appliesTo: "FX funding and SWIFT replacements",
      });
    }

    if (d.cause === "BANK_RETURN_ACCOUNT_CLOSED") {
      const entry = books.find((x) => x.id === b.entryIds[0]);
      const vendor = vendors.find((v) => v.name === entry?.counterparty);
      if (vendor && !has(`R-HOLD-${vendor.id}`)) {
        fresh.push({
          id: `R-HOLD-${vendor.id}`,
          learnedFrom: b.id,
          text: `Hold every payment to ${vendor.name} until new bank details are verified: the account on file is closed.`,
          appliesTo: vendor.name,
        });
      }
    }
  }
  return fresh;
}
