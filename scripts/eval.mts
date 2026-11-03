// Shuffled runs of the whole audit. Each run seeds the six breaks, then plays
// the three pieces of evidence in a random order, mixed with things a person
// might do at the wrong moment: audit again, press "resend", approve with a
// forged hash, approve something already done, approve terms that went stale.
// After every step it checks the rules that must never break.
//
//   pnpm eval              200 runs, offline rules reader
//   pnpm eval --runs 50
//   pnpm eval --model      read emails and word explanations with Claude (needs ANTHROPIC_API_KEY)
import { Session } from "@/lib/engine/session";
import type { ActionKind, Break, CauseCode } from "@/lib/engine/types";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string, fallback: number) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
const RUNS = opt("runs", 200);
const useModel = flag("model");
// The eval never touches the sandbox or a chain.
delete process.env.AWX_MODE;
process.env.METAL_MODE = "mock";

/** What the scenario actually planted, written down before the engine looks at it. */
function truth(b: Break): CauseCode {
  switch (b.kind) {
    case "RETURNED_AFTER_BOOKED_PAID":
      // INV-2039 is failed with ACCOUNT_CLOSED at seed. INV-2044 comes back later with a generic bank return.
      return b.id.includes("INV-2039") ? "BANK_RETURN_ACCOUNT_CLOSED" : "BANK_RETURN";
    case "FEE_NOT_FUNDED":
      // EUR and GBP are filled by conversions that left the fees out. USD is the funding pocket: nothing to convert.
      return b.currency === "USD" ? "PAYOUT_FEE_NOT_BOOKED" : "SWIFT_FEE_NOT_IN_FUNDING";
    case "IN_FLIGHT_DISPUTED":
      return "STILL_IN_FLIGHT";
    case "DUPLICATE_PAYMENT":
      return "MANUAL_RESUBMISSION";
    case "RECEIPT_MISSING":
      return "CUSTOMER_LATE";
    case "RECEIPT_SHORT":
      return "PAYER_BANK_CHARGE";
    case "FX_RATE_VARIANCE":
      return "RATE_MOVED_SINCE_PLAN";
  }
}

// Small seeded generator so a failing run can be replayed with --seed.
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LIVE = new Set(["PROCESSING", "SENT", "PAID"]);
// Money leaving a pocket, written out here rather than imported so the eval checks the policy instead of repeating it.
const MONEY_LEAVES: ActionKind[] = ["REPLACE", "PAY", "CONVERT", "TOP_UP"];
type Op = "deposit" | "return" | "email" | "audit" | "resend" | "tamper" | "replay" | "approve" | "again";

const tally = {
  runs: 0,
  steps: 0,
  causes: { right: 0, total: 0 },
  wrongCauses: new Map<string, number>(),
  doublePays: 0,
  unapprovedOverLimit: 0,
  forged: { refused: 0, total: 0 },
  replayed: { refused: 0, total: 0 },
  resend: { refused: 0, total: 0 },
  again: { blocked: 0, total: 0 },
  settled: 0,
  failures: [] as string[],
};

async function runOnce(seed: number) {
  const r = rng(seed);
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const s = new Session({ offline: !useModel });
  const approved = new Set<string>();
  const fail = (msg: string) => tally.failures.push(`seed ${seed}: ${msg}`);

  const check = (where: string) => {
    const v = s.view();
    // One live payment per invoice, counting both rails.
    const invoices = new Set([...v.ledger.transfers.map((t) => t.invoice), ...v.metalPayouts.map((m) => m.invoice)]);
    for (const inv of invoices) {
      const live = v.ledger.transfers.filter((t) => t.invoice === inv && LIVE.has(t.status)).length;
      const metal = v.metalPayouts.filter((m) => m.invoice === inv && m.outcome === "paid").length;
      // INV-2047 starts with two live payments on purpose. The audit must bring it to one.
      if (live + metal > 1 && !(inv === "INV-2047" && s.audits === 0)) {
        tally.doublePays++;
        fail(`${where}: ${inv} has ${live} live transfers and ${metal} Metal payouts`);
      }
    }
    for (const d of v.decisions) {
      const moved = d.status === "executed" || d.status === "scheduled";
      if (moved && d.needsApproval && !(d.approved && approved.has(d.id))) {
        tally.unapprovedOverLimit++;
        fail(`${where}: ${d.id} ran without the approval it needed`);
      }
      const outflow = MONEY_LEAVES.includes(d.chosen.kind) && d.chosen.rail !== "books";
      if (moved && outflow && !d.approved && d.chosen.amountUsd > d.autonomyLimitUsd) {
        tally.unapprovedOverLimit++;
        fail(`${where}: ${d.id} moved ${d.chosen.amountUsd} alone, limit ${d.autonomyLimitUsd}`);
      }
    }
  };

  const pending = () => s.view().decisions.filter((d) => d.status === "awaiting_approval");
  const transferCount = () => s.view().ledger.transfers.length + s.metalPayouts.length;

  await s.seed();
  await s.audit();
  check("audit 1");

  const extras: Op[] = ["audit", "resend", "tamper", "replay", "approve", "again"];
  const ops: Op[] = ["deposit", "return", "email"];
  const n = 3 + Math.floor(r() * 6);
  for (let i = 0; i < n; i++) ops.push(pick(extras));
  for (let i = ops.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [ops[i], ops[j]] = [ops[j], ops[i]];
  }

  for (const op of ops) {
    tally.steps++;
    if (op === "deposit" || op === "return" || op === "email") {
      await s.inject(op);
    } else if (op === "audit") {
      await s.audit();
    } else if (op === "resend") {
      const v = s.view();
      const inv = pick([...new Set(v.ledger.transfers.map((t) => t.invoice))]);
      const live = v.ledger.transfers.some((t) => t.invoice === inv && LIVE.has(t.status));
      const count = transferCount();
      const res = await s.tryResend(inv);
      if (live) {
        tally.resend.total++;
        if (res.refused) tally.resend.refused++;
        else fail(`resend of ${inv} was allowed while a payment is live`);
      }
      if (transferCount() !== count) fail(`resend of ${inv} created a payment`);
    } else if (op === "tamper") {
      const d = pending()[0];
      if (!d) continue;
      tally.forged.total++;
      const forged = d.binding.slice(0, -1) + (d.binding.endsWith("0") ? "1" : "0");
      const res = await s.approve(d.id, forged);
      if (!res.ok && res.reason === "binding_mismatch") tally.forged.refused++;
      else fail(`forged approval of ${d.id} was accepted`);
    } else if (op === "replay") {
      // A real signature, carried over from a different decision.
      const d = pick(pending());
      const other = d && pick(s.view().decisions.filter((x) => x.id !== d.id));
      if (!d || !other) continue;
      tally.replayed.total++;
      const res = await s.approve(d.id, other.binding);
      if (!res.ok) tally.replayed.refused++;
      else fail(`${other.id}'s signature approved ${d.id}`);
    } else if (op === "approve") {
      const d = pick(pending());
      if (!d) continue;
      approved.add(d.id);
      await s.approve(d.id, d.binding);
    } else if (op === "again") {
      const done = s.view().decisions.filter((d) => d.status === "executed");
      const d = pick(done);
      if (!d) continue;
      tally.again.total++;
      const count = transferCount();
      try {
        const res = await s.approve(d.id, d.binding);
        if (!res.ok) tally.again.blocked++;
        else fail(`approving ${d.id} a second time ran it again`);
      } catch {
        tally.again.blocked++;
      }
      if (transferCount() !== count) fail(`second approval of ${d.id} moved money`);
    }
    check(op);
  }

  // A person works through the queue until nothing is waiting.
  for (let round = 0; round < 6 && pending().length; round++) {
    for (const d of pending()) {
      approved.add(d.id);
      await s.approve(d.id, d.binding);
    }
    check("approvals");
  }

  const v = s.view();
  const breaks = new Map(v.breaks.map((b) => [b.id, b]));
  for (const dg of v.diagnoses) {
    const b = breaks.get(dg.breakId);
    if (!b) continue;
    const want = truth(b);
    tally.causes.total++;
    if (dg.cause === want) tally.causes.right++;
    else {
      const key = `${b.id}: said ${dg.cause}, planted ${want}`;
      tally.wrongCauses.set(key, (tally.wrongCauses.get(key) ?? 0) + 1);
    }
  }

  const unsettled = v.pockets.latest.filter((p) => Math.abs(p.residual) > 0.005);
  if (unsettled.length) fail(`unexplained residual at the end: ${unsettled.map((p) => `${p.currency} ${p.residual}`).join(", ")}`);
  else tally.settled++;
  tally.runs++;
}

const first = opt("seed", 1);
const started = Date.now();
for (let i = 0; i < RUNS; i++) await runOnce(first + i);

const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "n/a");
const line = (k: string, v: string) => console.log(`  ${k.padEnd(34)} ${v}`);
console.log(`\nAutopsy eval: ${tally.runs} shuffled runs, ${tally.steps} steps, ${useModel ? "Claude reader" : "rules reader"}, ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
line("Root cause matches what was planted", `${tally.causes.right}/${tally.causes.total} (${pct(tally.causes.right, tally.causes.total)})`);
line("Invoices paid twice", String(tally.doublePays));
line("Moves without the approval needed", String(tally.unapprovedOverLimit));
line("Forged approvals refused", `${tally.forged.refused}/${tally.forged.total}`);
line("Signatures replayed onto another decision refused", `${tally.replayed.refused}/${tally.replayed.total}`);
line("Resends refused while a payment is live", `${tally.resend.refused}/${tally.resend.total}`);
line("Second approvals that did nothing", `${tally.again.blocked}/${tally.again.total}`);
line("Runs ending with every residual 0", `${tally.settled}/${tally.runs}`);
if (tally.wrongCauses.size) {
  console.log("\n  Wrong causes:");
  for (const [k, n] of tally.wrongCauses) console.log(`    ${n}x ${k}`);
}
if (tally.failures.length) {
  console.log(`\n  ${tally.failures.length} failures, first 15:`);
  for (const f of tally.failures.slice(0, 15)) console.log(`    ${f}`);
  process.exit(1);
}
console.log("\n  All checks held.");
