// Checks, against the real Airwallex sandbox, the behaviours the audit relies on.
// Run it once after setup:sandbox and before recording anything.
//
//   AWX_CLIENT_ID=... AWX_API_KEY=... pnpm feasibility
//
// It moves sandbox money only: a USD 2,000 simulated deposit, a small EUR
// conversion and two EUR transfers to the Brennholz test beneficiary.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { r2 } from "@/lib/engine/money";
import { VENDORS } from "@/lib/engine/scenario";
import type { Beneficiary, Transfer } from "@/lib/engine/types";
import { SandboxAirwallex } from "@/lib/rails/airwallex/sandbox";

const { AWX_CLIENT_ID, AWX_API_KEY } = process.env;
const file = path.join(process.cwd(), ".autopsy", "sandbox.json");
if (!AWX_CLIENT_ID || !AWX_API_KEY || !existsSync(file)) {
  console.error("Needs AWX_CLIENT_ID, AWX_API_KEY and .autopsy/sandbox.json. Run pnpm setup:sandbox first.");
  process.exit(1);
}
const cfg = JSON.parse(readFileSync(file, "utf8")) as { usdGlobalAccountId: string; beneficiaries: Record<string, string> };
const api = new SandboxAirwallex(AWX_CLIENT_ID, AWX_API_KEY, cfg.usdGlobalAccountId);

const v = VENDORS.find((x) => x.id === "V-BRN")!;
const brn: Beneficiary = { id: cfg.beneficiaries[v.id], name: v.name, country: v.country, currency: v.currency, method: v.method, account: v.account };
const run = Date.now().toString(36);

type Verdict = "PASS" | "FAIL" | "INFO";
const results: { name: string; verdict: Verdict; detail: string }[] = [];
const report = (name: string, verdict: Verdict, detail: string) => {
  results.push({ name, verdict, detail });
  console.log(`  ${verdict.padEnd(4)} ${name}: ${detail}`);
};
async function step(name: string, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (err) {
    report(name, "FAIL", (err as Error).message);
  }
}

const eurAvailable = async () => {
  const rows = await api.call<{ currency: string; available_amount: number }[]>("GET", "/api/v1/balances/current");
  return Number(rows.find((b) => b.currency === "EUR")?.available_amount ?? 0);
};
const pay = (key: string, amount: number) =>
  api.createTransfer({
    request_id: `apx-feas-${key}-${run}`,
    beneficiary: brn,
    amount,
    currency: "EUR",
    method: "SWIFT",
    reference: `FEAS ${key}`,
    metadata: { invoice: `FEAS-${key}` },
  });

console.log(`Airwallex sandbox feasibility, run ${run}${process.env.AWX_API_VERSION ? `, API ${process.env.AWX_API_VERSION}` : ", account default API version"}\n`);

await step("Simulated deposit lands in USD", async () => {
  const d = await api.simulateDeposit({ amount: 2_000, currency: "USD", payer_name: "AUTOPSY FEASIBILITY" });
  report("Simulated deposit lands in USD", d.currency === "USD" ? "PASS" : "FAIL", `${d.id}, ${d.amount} ${d.currency}`);
});

await step("USD buys EUR", async () => {
  const c = await api.convert({ request_id: `apx-feas-fx-${run}`, buy_currency: "EUR", sell_currency: "USD", buy_amount: 300, metadata: {} });
  report("USD buys EUR", "PASS", `${c.id}: EUR ${c.buy_amount} for USD ${c.sell_amount}, rate ${c.client_rate}`);
});

let first: Transfer | undefined;
let before = 0;
await step("SWIFT payout charges a fee in the payout currency", async () => {
  before = await eurAvailable();
  first = await pay("a", 100);
  const fee = `${first.fee_amount} ${first.fee_currency}`;
  // The engine's R-FEE rule assumes the fee comes out of the same pocket.
  report("SWIFT payout charges a fee in the payout currency", first.fee_amount > 0 && first.fee_currency === "EUR" ? "PASS" : "INFO",
    `${first.short_reference_id} is ${first.status}, fee ${fee} (the mock uses 12.85 EUR)`);
});

await step("A request id finds the payment it created", async () => {
  if (!first) throw new Error("no transfer to look up");
  const found = await api.findTransferByRequestId(first.request_id);
  report("A request id finds the payment it created", found?.id === first.id ? "PASS" : "FAIL", found ? `found ${found.id}` : "nothing found");
});

await step("Reusing a request id cannot create a second payment", async () => {
  if (!first) throw new Error("no transfer to retry");
  try {
    const again = await pay("a", 100);
    report("Reusing a request id cannot create a second payment", again.id === first.id ? "PASS" : "FAIL",
      again.id === first.id ? "the same transfer came back" : `a second transfer ${again.id} was created`);
  } catch (err) {
    report("Reusing a request id cannot create a second payment", "PASS", `refused: ${(err as Error).message}`);
  }
});

await step("PAID is not final: a paid transfer can still fail", async () => {
  if (!first) throw new Error("no transfer to move");
  await api.transition(first.id, "SENT");
  await api.transition(first.id, "PAID");
  const t = await api.transition(first.id, "FAILED", "ACCOUNT_CLOSED");
  report("PAID is not final: a paid transfer can still fail", t.status === "FAILED" || t.status === "CANCELLED" ? "PASS" : "FAIL",
    `now ${t.status}, reason ${t.failure_reason ?? t.failure_type ?? "none given"}`);
  first = t;
});

await step("A failed payout comes back without its fee", async () => {
  if (!first) throw new Error("no failed transfer");
  if (first.status === "FAILED") {
    // Some API versions hold a FAILED transfer until it is cancelled.
    first = await api.cancelTransfer(first.id).catch(() => first!);
  }
  await new Promise((r) => setTimeout(r, 1_500));
  const after = await eurAvailable();
  const back = r2(after - (before - 100 - (first.fee_amount ?? 0)));
  report("A failed payout comes back without its fee", back === 100 ? "PASS" : "INFO",
    `EUR before ${before}, after ${after}: ${back} of 100 came back, fee ${first.fee_amount} (status ${first.status})`);
});

// The duplicate the engine cancels is a USD ACH payout to Kestrel that has had time to reach
// PROCESSING, so test exactly that. (A EUR SWIFT payout in PROCESSING is refused: update_unsupported.)
await step("A payout still PROCESSING can be cancelled", async () => {
  const k = VENDORS.find((x) => x.id === "V-KES")!;
  const kes: Beneficiary = { id: cfg.beneficiaries[k.id], name: k.name, country: k.country, currency: k.currency, method: k.method, account: k.account };
  const t = await api.createTransfer({
    request_id: `apx-feas-b-${run}`,
    beneficiary: kes,
    amount: 50,
    currency: "USD",
    method: "LOCAL",
    reference: "FEAS b",
    metadata: { invoice: "FEAS-b" },
  });
  let raw = "";
  for (let i = 0; i < 20 && (raw = String((await api.call<{ status: string }>("GET", `/api/v1/transfers/${t.id}`)).status)) !== "PROCESSING"; i++) {
    await new Promise((r) => setTimeout(r, 500));
  }
  try {
    const c = await api.cancelTransfer(t.id);
    report("A payout still PROCESSING can be cancelled", c.status === "CANCELLED" ? "PASS" : "FAIL", `USD ACH ${raw} -> ${c.status}`);
  } catch (err) {
    // The duplicate fix depends on this. If it fails, the engine refuses the cancel and asks a person to recall.
    report("A payout still PROCESSING can be cancelled", "FAIL", `USD ACH ${raw}, cancel refused: ${(err as Error).message}`);
  }
});

await step("Financial transactions show the fee and the refund", async () => {
  if (!first) throw new Error("no transfer");
  const page = await api.call<{ items?: { transaction_type?: string; amount?: number; currency?: string }[] }>(
    "GET",
    `/api/v1/financial_transactions?source_id=${first.id}`,
  );
  const rows = page.items ?? [];
  report("Financial transactions show the fee and the refund", "INFO",
    rows.length ? rows.map((x) => `${x.transaction_type} ${x.amount} ${x.currency}`).join(", ") : "no rows for this transfer yet");
});

const failed = results.filter((x) => x.verdict === "FAIL");
console.log(`\n${results.length - failed.length}/${results.length} checks passed or informational, ${failed.length} failed.`);
process.exit(failed.length ? 1 : 0);
