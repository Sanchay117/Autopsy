import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { MockAirwallex } from "@/lib/rails/airwallex/mock";
import type { AirwallexRail } from "@/lib/rails/airwallex/rail";
import { SandboxAirwallex } from "@/lib/rails/airwallex/sandbox";
import { MockMetal, OffMetal, TestnetMetal, type MetalPayout, type MetalRail } from "@/lib/rails/metal";
import { execute, FINAL, type ActContext, type Draft } from "./act";
import { decide } from "./decide";
import { buildEvidence, diagnose } from "./diagnose";
import { learn } from "./learn";
import { DuplicateLock, LockRefused } from "./lock";
import { fmt, r2, type UsdRates } from "./money";
import { bindingHash } from "./policy";
import { explain, modelEnabled, readEmail } from "./read";
import { detect, type Detection, type Ground, type JournalLine } from "./reconcile";
import {
  ALDER_DEPOSIT, AUDIT_DATE, COMPANY, INBOX, initialBooks, LATE_EMAIL, POCKETS, SENT_ON, VENDORS,
} from "./scenario";
import type {
  Beneficiary, BookEntry, Break, Currency, Decision, DecisionDiff, Diagnosis, Email, EmailClaims, Evidence,
  Rule, TraceStep, Transfer, TransferStatus,
} from "./types";

export type InjectKind = "deposit" | "return" | "email";

interface SandboxConfig {
  usdGlobalAccountId: string;
  beneficiaries: Record<string, string>;
}

function sandboxConfig(): SandboxConfig | null {
  const file = path.join(process.cwd(), ".autopsy", "sandbox.json");
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as SandboxConfig) : null;
}

/** The mandate credential pnpm setup:metal writes, if it has run. */
function metalCredential(): string | undefined {
  const file = path.join(process.cwd(), ".autopsy", "metal", "mandate.json");
  return existsSync(file) ? file : undefined;
}

/**
 * One audit of one company, held in memory. Every mutation goes through a
 * queue, so two clicks in the dashboard can never act on the same state.
 */
export class Session {
  readonly rail: AirwallexRail;
  readonly metal: MetalRail;
  readonly ns = randomUUID().slice(0, 6);
  readonly lock: DuplicateLock;
  private queue: Promise<unknown> = Promise.resolve();

  seeded = false;
  books: BookEntry[] = [];
  journal: JournalLine[] = [];
  ids = { transfers: [] as string[], conversions: [] as string[], deposits: [] as string[] };
  seen = new Map<string, { status: TransferStatus; at: string }[]>();
  beneficiaries: Record<string, Beneficiary> = {};
  emails: Email[] = [];
  claims: EmailClaims[] = [];
  rules: Rule[] = [];
  decisions = new Map<string, Decision>();
  diagnoses = new Map<string, Diagnosis>();
  breaksSeen = new Map<string, Break>();
  evidence: Evidence[] = [];
  trace: TraceStep[] = [];
  diffs: (DecisionDiff & { rechecked: string[] })[] = [];
  drafts: Draft[] = [];
  metalPayouts: (MetalPayout & { decisionId: string; invoice: string })[] = [];
  executedKeys = new Set<string>();
  injected: Record<InjectKind, boolean> = { deposit: false, return: false, email: false };
  rates: UsdRates = { USD: 1, EUR: 1 / 0.9208, GBP: 1 / 0.7864 };
  ground: Ground = { transfers: [], conversions: [], deposits: [] };
  opening?: Detection;
  latest?: Detection;
  audits = 0;
  /** What the agent is doing right now, for the dashboard while a step runs. */
  activity: string | null = null;

  /** `offline` forces the mock rails and rule-based reading, for the landing page preview. */
  constructor(private opts: { offline?: boolean } = {}) {
    const cfg = opts.offline ? null : sandboxConfig();
    if (!opts.offline && process.env.AWX_MODE === "sandbox") {
      if (!process.env.AWX_CLIENT_ID || !process.env.AWX_API_KEY || !cfg) {
        throw new Error("AWX_MODE=sandbox needs AWX_CLIENT_ID, AWX_API_KEY and .autopsy/sandbox.json (run pnpm setup:sandbox)");
      }
      this.rail = new SandboxAirwallex(process.env.AWX_CLIENT_ID, process.env.AWX_API_KEY, cfg.usdGlobalAccountId);
    } else {
      this.rail = new MockAirwallex();
    }
    const m = opts.offline ? "mock" : process.env.METAL_MODE ?? "mock";
    if (m === "testnet") {
      const credential = process.env.METAL_CREDENTIAL || metalCredential();
      if (!credential || !process.env.METAL_RPC_URL) {
        throw new Error("METAL_MODE=testnet needs METAL_RPC_URL and a bound mandate (run pnpm setup:metal)");
      }
      this.metal = new TestnetMetal(credential, process.env.METAL_RPC_URL, Number(process.env.METAL_SCALE || 0.001));
    } else {
      this.metal = m === "off" ? new OffMetal() : new MockMetal(10_000);
    }
    this.lock = new DuplicateLock(this.rail, this.ns);
    for (const v of VENDORS) {
      this.beneficiaries[v.id] = {
        id: cfg?.beneficiaries[v.id] ?? `ben-${v.id}`,
        name: v.name,
        country: v.country,
        currency: v.currency,
        method: v.method,
        account: v.account,
      };
    }
  }

  /** Run `fn` after everything queued before it. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = async () => {
      try {
        return await fn();
      } finally {
        this.activity = null;
      }
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private log(stage: TraceStep["stage"], text: string, ref?: string) {
    this.trace.push({ at: new Date().toISOString(), stage, text, ref });
  }

  private doing(text: string) {
    this.activity = text;
  }

  private observe(t: Transfer): Transfer {
    const mine = this.seen.get(t.id) ?? [];
    const theirs = t.history ?? [];
    let merged = theirs.length > mine.length ? theirs : mine;
    if (merged.at(-1)?.status !== t.status) merged = [...merged, { status: t.status, at: new Date().toISOString() }];
    this.seen.set(t.id, merged);
    return { ...t, history: merged };
  }

  // ---------- Seed: put six real breaks into the sandbox ----------

  seed() {
    return this.serial(async () => {
      if (this.seeded) return;
      const rid = (k: string) => `seed-${k}-${this.ns}`;
      this.log("seed", `Seeding ${COMPANY} into Airwallex ${this.rail.mode === "sandbox" ? "sandbox" : "mock"}, run ${this.ns}`);

      this.doing("Simulating the USD 30,000 funding deposit");
      const funding = await this.rail.simulateDeposit({ amount: 30_000, currency: "USD", payer_name: "HARROW & FINCH TREASURY" });
      this.ids.deposits.push(funding.id);
      this.log("seed", `Deposited ${fmt(30_000, "USD")} into the USD pocket (simulated deposit)`, funding.id);

      this.doing("Buying EUR and GBP with USD (FXP-118, FXP-119)");
      const c118 = await this.rail.convert({ request_id: rid("FXP-118"), buy_currency: "EUR", sell_currency: "USD", buy_amount: 6_000, metadata: { plan: "FXP-118", autopsy: this.ns } });
      const c119 = await this.rail.convert({ request_id: rid("FXP-119"), buy_currency: "GBP", sell_currency: "USD", buy_amount: 3_200, metadata: { plan: "FXP-119", autopsy: this.ns } });
      this.ids.conversions.push(c118.id, c119.id);
      this.rates = { USD: 1, EUR: c118.sell_amount / c118.buy_amount, GBP: c119.sell_amount / c119.buy_amount };
      this.log("seed", `FXP-118: bought ${fmt(6_000, "EUR")} for ${fmt(c118.sell_amount, "USD")}. The plan assumed 0.915, and the fees were left out of the amount`, c118.id);
      this.log("seed", `FXP-119: bought ${fmt(3_200, "GBP")} for ${fmt(c119.sell_amount, "USD")}`, c119.id);

      this.books = initialBooks(3_200 / c119.sell_amount);
      this.emails = [...INBOX];

      const pay = async (inv: string, suffix = "a") => {
        const e = this.books.find((b) => b.id === inv)!;
        const v = VENDORS.find((x) => x.name === e.counterparty)!;
        this.doing(`Paying ${inv} to ${e.counterparty}`);
        const t = await this.rail.createTransfer({
          request_id: rid(`${inv}-${suffix}`),
          beneficiary: this.beneficiaries[v.id],
          amount: e.amount,
          currency: e.currency,
          method: e.method!,
          reference: inv,
          metadata: { invoice: inv, autopsy: this.ns },
        });
        this.ids.transfers.push(t.id);
        this.observe(t);
        return t;
      };
      const move = async (t: Transfer, ...steps: [TransferStatus, string?][]) => {
        for (const [s, f] of steps) {
          this.doing(`Moving ${t.metadata.invoice} to ${s}${f ? ` (${f})` : ""}`);
          this.observe(await this.rail.transition(t.id, s, f));
        }
      };

      const harbour = await pay("INV-2039");
      await move(harbour, ["SENT"], ["PAID"]);
      try {
        await move(harbour, ["FAILED", "ACCOUNT_CLOSED"]);
      } catch {
        this.log("seed", `Sandbox refused PAID → FAILED for INV-2039; it stays PAID`);
      }
      this.log("seed", `INV-2039 to Harbour Print: SENT, PAID, then returned with ACCOUNT_CLOSED. Books still say paid`, harbour.id);

      const sau = await pay("INV-2041");
      await move(sau, ["SENT"], ["PAID"]);
      this.log("seed", `INV-2041 to Sauer: SWIFT, PAID, fee ${fmt(sau.fee_amount, sau.fee_currency)} taken from the EUR pocket`);

      const brn = await pay("INV-2044");
      await move(brn, ["SENT"]);
      this.log("seed", `INV-2044 to Brennholz: SWIFT, SENT on 28 Oct and not yet PAID`, brn.id);

      const a = await pay("INV-2047", "a");
      const b = await pay("INV-2047", "b");
      this.log("seed", `INV-2047 to Kestrel submitted twice with different request ids (a manual resubmission). Both PROCESSING`, `${a.id},${b.id}`);
      this.log("seed", `Inbox: ${INBOX.map((e) => `${e.id} from ${e.from}`).join(", ")}`);
      this.seeded = true;
    });
  }

  // ---------- The audit loop ----------

  private async readGround() {
    const { transfers: t, conversions: c, deposits: d } = this.ids;
    this.doing(`Reading ${t.length} transfers, ${c.length} conversions and ${d.length} deposits from Airwallex`);
    const [transfers, conversions, deposits] = await Promise.all([
      Promise.all(this.ids.transfers.map(async (id) => this.observe(await this.rail.getTransfer(id)))),
      Promise.all(this.ids.conversions.map((id) => this.rail.getConversion(id))),
      Promise.all(this.ids.deposits.map((id) => this.rail.getDeposit(id))),
    ]);
    this.ground = { transfers, conversions, deposits };
    return this.ground;
  }

  private async readInbox() {
    const known = {
      invoices: this.books.map((b) => b.id),
      counterparties: [...new Set(this.books.map((b) => b.counterparty).filter((c) => c !== "Treasury plan"))],
    };
    for (const e of this.emails) {
      if (this.claims.some((c) => c.emailId === e.id)) continue;
      this.doing(`${this.claude() ? "Claude is reading" : "Reading"} ${e.id} from ${e.from}`);
      const c = await readEmail(e, known, !this.opts.offline);
      this.claims.push(c);
      this.log("evidence", `${e.id} read by ${c.extractedBy === "claude" ? "Claude" : "rules"}: ${c.counterparty}, ${c.claim.replace(/_/g, " ")} (${c.invoiceRefs.join(", ") || "no invoice"})${c.quotedAccount ? `, quotes ${c.quotedAccount}` : ""}`, `ev:${e.id}`);
    }
  }

  private claude() {
    return modelEnabled() && !this.opts.offline;
  }

  private detectNow() {
    return detect({
      books: this.books, journal: this.journal, pockets: POCKETS, ground: this.ground, claims: this.claims,
      auditDate: AUDIT_DATE, sentOn: SENT_ON, rates: this.rates, openingDeposited: true,
    });
  }

  /**
   * Detect, diagnose, learn, decide, act. With `touched`, the trace and diff
   * report which decisions the new evidence changed and which it left alone.
   */
  private async pipeline(opts: { act: boolean; touched?: Set<string> }) {
    await this.readGround();
    await this.readInbox();
    const det = this.detectNow();
    this.opening ??= det;
    this.audits++;
    for (const b of det.breaks) this.breaksSeen.set(b.id, b);

    for (const p of det.pockets) {
      if (p.bank === 0 && p.books === 0) continue;
      this.log("detect", `${p.currency} pocket: bank ${fmt(p.bank, p.currency)}, books ${fmt(p.books, p.currency)}, variance ${fmt(p.variance, p.currency)}, explained ${fmt(p.explained, p.currency)}, residual ${fmt(p.residual, p.currency)}`);
    }
    for (const b of det.breaks) this.log("detect", b.title, b.id);

    this.evidence = buildEvidence(this.ground, this.books, this.emails, this.claims, SENT_ON);
    let diags = diagnose({ breaks: det.breaks, ground: this.ground, books: this.books, claims: this.claims, vendors: VENDORS, pockets: POCKETS, auditDate: AUDIT_DATE, sentOn: SENT_ON });
    this.doing(`${this.claude() ? "Claude is wording" : "Wording"} ${diags.length} explanations`);
    diags = await explain(diags, !this.opts.offline);
    for (const d of diags) {
      const prev = this.diagnoses.get(d.breakId);
      this.diagnoses.set(d.breakId, d);
      if (!prev || prev.cause !== d.cause || prev.confidence !== d.confidence) {
        this.log("diagnose", `${d.breakId}: ${d.causeLabel}, confidence ${d.confidence.toFixed(2)}${d.counterfactual ? `. ${d.counterfactual.question} ${d.counterfactual.replayed.value}` : ""}`, d.breakId);
      }
    }

    for (const r of learn(det.breaks, diags, this.books, this.rules, VENDORS)) {
      this.rules.push(r);
      this.log("learn", `New rule ${r.id} from ${r.learnedFrom}: ${r.text}`, r.id);
    }

    const fresh = decide({
      breaks: det.breaks, diagnoses: diags, books: this.books, transfers: this.ground.transfers, vendors: VENDORS,
      claims: this.claims, rates: this.rates, rules: this.rules, auditDate: AUDIT_DATE, executedKeys: this.executedKeys,
      metalEnabled: this.metal.mode !== "off",
      balances: Object.fromEntries(det.pockets.map((p) => [p.currency, p.bank])) as Record<Currency, number>,
      floors: Object.fromEntries(POCKETS.map((p) => [p.currency, p.reserveFloor])) as Record<Currency, number>,
    });
    const changed = this.merge(fresh, det.breaks);

    if (opts.act) {
      for (const d of fresh) {
        const cur = this.decisions.get(d.id)!;
        if (cur.status === "proposed") await this.carryOut(cur, false);
      }
    }
    await this.readGround();
    this.latest = this.detectNow();
    return changed;
  }

  /** Fold fresh decisions into the session. Done is done: final actions are never redecided. */
  private merge(fresh: Decision[], breaks: Break[]) {
    const changed: { before?: Decision; after: Decision }[] = [];
    const freshIds = new Set(fresh.map((d) => d.id));
    for (const d of fresh) {
      const old = this.decisions.get(d.id);
      if (old && (old.status === "executed" || old.status === "refused") && (FINAL.includes(old.chosen.kind) || old.binding === d.binding)) continue;
      const same = old && old.binding === d.binding && old.needsApproval === d.needsApproval && old.chosen.kind === d.chosen.kind;
      if (same) {
        this.decisions.set(d.id, { ...d, status: old.status, result: old.result, revision: old.revision });
        continue;
      }
      const next = { ...d, revision: (old?.revision ?? 0) + 1 };
      this.decisions.set(d.id, next);
      changed.push({ before: old, after: next });
      const how = next.needsApproval ? `needs approval: ${next.approvalReason}` : next.status === "scheduled" ? `scheduled for ${next.executeOn}` : "within autonomy";
      this.log(old ? "revise" : "decide", `${next.id}: ${next.chosen.label}. ${how}`, next.id);
    }
    for (const [id, old] of this.decisions) {
      if (freshIds.has(id) || old.status === "superseded" || this.executedKeys.has(old.breakId)) continue;
      if (old.status === "executed" && FINAL.includes(old.chosen.kind)) continue;
      const stillBroken = breaks.some((b) => b.id === old.breakId);
      if (stillBroken) continue;
      this.decisions.set(id, { ...old, status: "superseded", result: old.result ? `${old.result}. Superseded by new evidence` : "Superseded by new evidence" });
      changed.push({ before: old, after: this.decisions.get(id)! });
    }
    return changed;
  }

  private ctx(): ActContext {
    return {
      rail: this.rail, metal: this.metal, lock: this.lock, ns: this.ns, books: this.books, journal: this.journal,
      breaks: [...this.breaksSeen.values()], transfers: this.ground.transfers, vendors: VENDORS,
      beneficiaries: this.beneficiaries, rules: this.rules, now: () => new Date().toISOString(),
      track: (kind, id) => (kind === "transfer" ? this.ids.transfers : this.ids.conversions).push(id),
      drafts: this.drafts, metalPayouts: this.metalPayouts,
    };
  }

  private async carryOut(d: Decision, approved: boolean) {
    this.doing(`${d.id}: ${d.chosen.label}`);
    const res = await execute(this.ctx(), d);
    const status: Decision["status"] = !res.ok ? "refused" : d.chosen.kind === "CONVERT" ? "scheduled" : "executed";
    this.decisions.set(d.id, { ...d, status, result: res.text, approved: approved || undefined });
    if (res.ok && FINAL.includes(d.chosen.kind)) this.executedKeys.add(d.breakId);
    this.log("act", `${d.id}${approved ? " (approved)" : ""}: ${res.text}`, d.id);
    // Keep the ground current so the next action in this run sees it.
    await this.readGround();
  }

  audit() {
    return this.serial(async () => {
      if (!this.seeded) throw new Error("Seed first");
      this.log("detect", `Audit ${this.audits + 1} for ${COMPANY}, as of ${AUDIT_DATE}`);
      await this.pipeline({ act: true });
    });
  }

  // ---------- New evidence ----------

  inject(kind: InjectKind) {
    return this.serial(async () => {
      if (!this.seeded) throw new Error("Seed first");
      if (this.injected[kind]) throw new Error(`${kind} already injected`);
      const before = new Map(this.decisions);
      let evidenceId = "";
      let label = "";
      let detail = "";
      let touched: string[] = [];

      if (kind === "deposit") {
        this.doing(`Simulating ${ALDER_DEPOSIT.payer_name}'s deposit`);
        const d = await this.rail.simulateDeposit({ ...ALDER_DEPOSIT, currency: "USD" });
        this.ids.deposits.push(d.id);
        evidenceId = `ev:${d.id}`;
        label = `Deposit lands: ${fmt(ALDER_DEPOSIT.amount, "USD")} from ${ALDER_DEPOSIT.payer_name}`;
        touched = [d.id, "AR-7781", "pocket:USD"];
      } else if (kind === "return") {
        const t = this.ground.transfers.find((x) => x.metadata.invoice === "INV-2044" && x.status === "SENT");
        if (!t) throw new Error("INV-2044 is no longer in flight");
        this.doing("Having Brennholz's bank return INV-2044");
        this.observe(await this.rail.transition(t.id, "FAILED", "BENEFICIARY_BANK_RETURNED"));
        evidenceId = `ev:${t.id}`;
        label = `Bank return: Brennholz's bank sends INV-2044 back`;
        detail = " (FAILED, BENEFICIARY_BANK_RETURNED)";
        touched = [t.id, "INV-2044", "pocket:EUR"];
      } else {
        this.emails.push(LATE_EMAIL);
        evidenceId = `ev:${LATE_EMAIL.id}`;
        label = `Email: Copperline will pay ${fmt(6_000, "USD")} of AR-7790 on 20 Nov, balance later`;
        touched = [LATE_EMAIL.id, `ev:${LATE_EMAIL.id}`, "AR-7790"];
      }
      this.injected[kind] = true;
      this.log("evidence", label + detail, evidenceId);

      const set = new Set(touched);
      await this.pipeline({ act: true, touched: set });

      const entryOf = (id: string) => id.match(/(INV|AR)-\d+$/)?.[0];
      const summary = (d?: Decision) => d && { action: d.chosen.label, approval: d.needsApproval, confidence: d.confidence };
      const changes: DecisionDiff["changes"] = [];
      const rechecked: string[] = [];
      const untouched: string[] = [];
      for (const [id, after] of this.decisions) {
        let prev = before.get(id);
        if (!prev) prev = [...before.values()].find((p) => entryOf(p.breakId) && entryOf(p.breakId) === entryOf(after.breakId) && this.decisions.get(p.id)?.status === "superseded");
        const differs = !prev || prev.binding !== after.binding || prev.needsApproval !== after.needsApproval || prev.chosen.kind !== after.chosen.kind;
        if (after.status === "superseded" && prev?.status !== "superseded") continue;
        if (differs) {
          changes.push({
            breakId: after.breakId,
            before: summary(prev) ?? { action: "none", approval: false, confidence: 0 },
            after: summary(after)!,
          });
        } else if (after.dependsOn.some((x) => set.has(x))) rechecked.push(id);
        else untouched.push(id);
      }
      this.diffs.push({ evidenceId, evidenceLabel: label, changes, rechecked, untouched });
      this.log("revise", `${changes.length} decision${changes.length === 1 ? "" : "s"} changed, ${rechecked.length} rechecked and unchanged, ${untouched.length} untouched`);
    });
  }

  // ---------- Approval ----------

  approve(decisionId: string, binding: string) {
    return this.serial(async () => {
      const d = this.decisions.get(decisionId);
      if (!d) throw new Error(`No decision ${decisionId}`);
      if (d.status !== "awaiting_approval") throw new Error(`${decisionId} is ${d.status}, not awaiting approval`);
      if (binding !== d.binding || bindingHash(d.bindingTerms) !== d.binding) {
        this.log("act", `${decisionId}: approval refused. It was given for terms ${binding}, the decision now reads ${d.binding}`, decisionId);
        return { ok: false, reason: "binding_mismatch" };
      }
      // Re-read the bank before acting on an approval: the world may have moved.
      await this.pipeline({ act: false });
      const now = this.decisions.get(decisionId);
      if (!now || now.binding !== binding || now.status !== "awaiting_approval") {
        this.log("act", `${decisionId}: approval void. Terms changed since it was asked for (${binding} → ${now?.binding ?? "gone"})`, decisionId);
        return { ok: false, reason: "terms_changed" };
      }
      await this.carryOut(now, true);
      await this.pipeline({ act: true });
      return { ok: this.decisions.get(decisionId)?.status !== "refused" };
    });
  }

  /** What a person clicking "send it again" would hit: the lock, checked against the bank. */
  tryResend(invoice: string) {
    return this.serial(async () => {
      await this.readGround();
      const prior = this.ground.transfers.filter((t) => t.metadata.invoice === invoice).map((t) => t.id);
      try {
        await this.lock.assertFree(prior);
        this.log("act", `Manual resend of ${invoice}: the lock is free, so a replacement may go through its decision and approval. Nothing was sent from this button`);
        return { refused: false, reason: "lock free" };
      } catch (err) {
        if (!(err instanceof LockRefused)) throw err;
        this.log("act", `Manual resend of ${invoice} refused. ${err.message}`, err.holder.id);
        return { refused: true, reason: err.message };
      }
    });
  }

  // ---------- Read model for the dashboard ----------

  view() {
    const decisions = [...this.decisions.values()];
    return {
      company: COMPANY,
      auditDate: AUDIT_DATE,
      run: this.ns,
      mode: { airwallex: this.rail.mode, metal: this.metal.mode, model: this.claude() ? "claude-opus-5-5" : "rules" },
      seeded: this.seeded,
      audits: this.audits,
      injected: this.injected,
      rates: this.rates,
      pockets: { opening: this.opening?.pockets ?? [], latest: this.latest?.pockets ?? [] },
      openBreaks: this.latest?.breaks.map((b) => b.id) ?? [],
      breaks: [...this.breaksSeen.values()],
      diagnoses: [...this.diagnoses.values()],
      decisions,
      rules: this.rules,
      evidence: this.evidence,
      claims: this.claims,
      emails: this.emails,
      trace: this.trace,
      diffs: this.diffs,
      drafts: this.drafts,
      metalPayouts: this.metalPayouts,
      journal: this.journal,
      ledger: {
        transfers: this.ground.transfers.map((t) => ({
          id: t.id, ref: t.short_reference_id, request_id: t.request_id, invoice: t.metadata.invoice,
          amount: t.transfer_amount, currency: t.transfer_currency, method: t.transfer_method, fee: t.fee_amount,
          status: t.status, failure: t.failure_reason, path: t.history.map((h) => h.status),
        })),
        conversions: this.ground.conversions.map((c) => ({ id: c.id, plan: c.metadata.plan, buy: fmt(c.buy_amount, c.buy_currency), sell: fmt(c.sell_amount, c.sell_currency), rate: r2(c.client_rate * 10_000) / 10_000 })),
        deposits: this.ground.deposits.map((d) => ({ id: d.id, amount: d.amount, currency: d.currency, payer: d.payer_name })),
      },
    };
  }
}

export type AuditView = ReturnType<Session["view"]>;

const g = globalThis as unknown as { __autopsy?: Session };

export function session() {
  g.__autopsy ??= new Session();
  return g.__autopsy;
}

export function resetSession() {
  g.__autopsy = new Session();
  return g.__autopsy;
}
