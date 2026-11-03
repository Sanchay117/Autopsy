"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Tally } from "@/components/Tally";
import { fmt } from "@/lib/engine/money";
import type { AuditView } from "@/lib/engine/session";
import type { Decision } from "@/lib/engine/types";

type Body =
  | { action: "seed" | "audit" | "reset" }
  | { action: "inject"; kind: "deposit" | "return" | "email" }
  | { action: "approve"; decisionId: string; binding: string }
  | { action: "resend"; invoice: string };

type Tab = "trace" | "changes" | "ledger" | "drafts" | "rules";

type TraceStep = AuditView["trace"][number];

/** A step in flight: trace lines logged since it started, what is happening now, and when it started. */
interface Live {
  trace: TraceStep[];
  activity: string | null;
  started: number;
  now: number;
}

const MONEY = /^-?[A-Z]{3} [\d,.]+$/;

const FINAL = ["CANCEL_DUPLICATE", "TOP_UP", "POST_ADJUSTMENT", "PAY", "REPLACE", "CONVERT", "REQUEST_DETAILS"];

interface Status {
  key: "open" | "needs" | "fixed" | "holding" | "scheduled" | "superseded" | "refused" | "cleared";
  text: string;
}

function statusOf(open: boolean, d?: Decision): Status {
  if (!d) return open ? { key: "open", text: "open" } : { key: "cleared", text: "cleared" };
  switch (d.status) {
    case "awaiting_approval":
      return { key: "needs", text: "needs you" };
    case "scheduled":
      return { key: "scheduled", text: d.approved ? "approved" : "scheduled" };
    case "refused":
      return { key: "refused", text: "refused" };
    case "superseded":
      return { key: "superseded", text: "superseded" };
    case "executed":
      return FINAL.includes(d.chosen.kind) ? { key: "fixed", text: d.approved ? "fixed, signed" : "fixed" } : { key: "holding", text: "holding" };
    default:
      return { key: "open", text: "proposed" };
  }
}

const RANK: Record<Status["key"], number> = { needs: 0, open: 1, refused: 2, holding: 3, scheduled: 4, fixed: 5, cleared: 6, superseded: 7 };

function Meter({ value }: { value: number }) {
  const n = Math.round(value * 10);
  return (
    <span className="d-meter" aria-label={`confidence ${value.toFixed(2)}`}>
      {Array.from({ length: 10 }, (_, i) => (
        <i key={i} className={i < n ? "on" : ""} />
      ))}
      <b className="num">{value.toFixed(2)}</b>
    </span>
  );
}

export function Dashboard() {
  const [view, setView] = useState<AuditView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("trace");
  const [live, setLive] = useState<Live | null>(null);
  const rightPane = useRef<HTMLElement>(null);

  useEffect(() => {
    fetch("/api/audit")
      .then((r) => r.json())
      .then(setView)
      .catch(() => setError("Could not reach the audit API"));
  }, []);

  const post = useCallback(async (body: Body, label: string, since: number) => {
    setBusy(label);
    setError(null);
    setNotice(null);
    const started = Date.now();
    setLive({ trace: [], activity: null, started, now: started });
    // On the sandbox a step takes tens of seconds. Poll it so the trace fills in while the agent works.
    let polling = true;
    const timer = setInterval(async () => {
      try {
        const p = (await (await fetch(`/api/audit?since=${since}`)).json()) as Pick<Live, "trace" | "activity">;
        if (polling) setLive({ ...p, started, now: Date.now() });
      } catch {
        // A missed poll only delays the feed. The step's own response still arrives.
      }
    }, 700);
    try {
      const res = await fetch("/api/audit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const json = (await res.json()) as { view: AuditView; error?: string; result?: { ok?: boolean; reason?: string; refused?: boolean } };
      setView(json.view);
      if (json.error) setError(json.error);
      return json;
    } catch {
      setError("The request failed");
    } finally {
      polling = false;
      clearInterval(timer);
      setLive(null);
      setBusy(null);
    }
  }, []);

  // Follow the trace inside its own column, never by scrolling the page.
  useEffect(() => {
    const el = rightPane.current;
    if (el) el.scrollTop = tab === "trace" ? el.scrollHeight : 0;
  }, [view?.trace.length, view?.diffs.length, live?.trace.length, live?.activity, tab]);

  const decisionFor = useCallback((id: string) => view?.decisions.find((d) => d.breakId === id), [view]);

  const queue = useMemo(() => {
    if (!view) return [];
    const open = new Set(view.openBreaks);
    return view.breaks
      .map((b) => ({ b, d: decisionFor(b.id), s: statusOf(open.has(b.id), decisionFor(b.id)) }))
      .sort((x, y) => RANK[x.s.key] - RANK[y.s.key]);
  }, [view, decisionFor]);

  const plans = useMemo(() => view?.decisions.filter((d) => d.breakId.startsWith("OBL-") || d.breakId.startsWith("PLAN-")) ?? [], [view]);

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" });
  }, [selected]);

  // Default selection: whatever needs a person, else the first break.
  useEffect(() => {
    if (!view || (selected && (view.breaks.some((b) => b.id === selected) || plans.some((p) => p.breakId === selected)))) return;
    const pick = view.decisions.find((d) => d.status === "awaiting_approval")?.breakId ?? queue[0]?.b.id ?? null;
    setSelected(pick);
  }, [view, selected, queue, plans]);

  if (!view) {
    return (
      <div className="d-loading mono dim">Opening the audit…</div>
    );
  }

  const run = async (body: Body, label: string) => {
    const before = view.diffs.length;
    // Watch the agent work in the trace; evidence switches to its changes when it is done.
    if (body.action !== "reset" && body.action !== "resend") setTab("trace");
    const res = await post(body, label, view.trace.length);
    if (!res?.view) return;
    if (body.action === "inject" && res.view.diffs.length > before) {
      const diff = res.view.diffs.at(-1)!;
      setTab("changes");
      if (diff.changes[0]) setSelected(diff.changes[0].breakId);
    }
    if (body.action === "audit" || body.action === "seed") setTab("trace");
    if (body.action === "reset") setSelected(null);
    if (body.action === "approve") {
      const r = res.result;
      setNotice(r?.ok ? "Approved and carried out on the exact terms shown." : r?.reason === "binding_mismatch" ? "Refused: the approval was for different terms than the decision now shows." : r?.reason === "terms_changed" ? "Refused: the bank changed since the approval was asked for. Review the new terms." : "Approval did not go through.");
    }
    if (body.action === "resend") setNotice(res.result?.refused ? (res.result.reason ?? "Refused by the duplicate lock") : "The lock is free. A replacement still goes through its decision and approval.");
  };

  const steps: { n: string; label: string; sub: string; done: boolean; enabled: boolean; body: Body }[] = [
    { n: "01", label: "Seed the sandbox", sub: "Six breaks into Airwallex", done: view.seeded, enabled: !view.seeded, body: { action: "seed" } },
    { n: "02", label: view.audits > 0 ? "Audit again" : "Run the audit", sub: "Detect, diagnose, decide, act", done: view.audits > 0, enabled: view.seeded, body: { action: "audit" } },
    { n: "E1", label: "Deposit lands", sub: "USD 17,975 from Alder Street", done: view.injected.deposit, enabled: view.audits > 0 && !view.injected.deposit, body: { action: "inject", kind: "deposit" } },
    { n: "E2", label: "Bank return", sub: "INV-2044 comes back", done: view.injected.return, enabled: view.audits > 0 && !view.injected.return, body: { action: "inject", kind: "return" } },
    { n: "E3", label: "Customer email", sub: "Copperline pays half, late", done: view.injected.email, enabled: view.audits > 0 && !view.injected.email, body: { action: "inject", kind: "email" } },
  ];

  const sel = view.breaks.find((b) => b.id === selected);
  const selDecision = selected ? decisionFor(selected) : undefined;
  const selDiag = view.diagnoses.find((d) => d.breakId === selected);
  const evidence = (id: string) => view.evidence.find((e) => e.id === id);
  const pockets = view.pockets.latest.filter((p) => {
    const o = view.pockets.opening.find((x) => x.currency === p.currency);
    return p.bank !== 0 || p.books !== 0 || (o && o.variance !== 0);
  });
  const needs = view.decisions.filter((d) => d.status === "awaiting_approval").length;
  const trace = live ? [...view.trace, ...live.trace] : view.trace;
  const secs = live ? Math.round((live.now - live.started) / 1000) : 0;
  const livePayment = (inv: string) => view.ledger.transfers.some((t) => t.invoice === inv && ["PROCESSING", "SENT", "PAID"].includes(t.status));

  return (
    <div className="d-shell">
      <div className="d-top">
      <header className="d-bar">
        <Link href="/" className="brand mono">
          <img src="/mark.svg" alt="" />
          Autopsy
        </Link>
        <span className="d-company">
          <b>{view.company}</b>
          <span className="mono dim">as of {view.auditDate}</span>
        </span>
        <span className="d-modes mono">
          <span title="Airwallex rail">Airwallex <b>{view.mode.airwallex}</b></span>
          <span title="Metal rail">Metal <b>{view.mode.metal}</b></span>
          <span title="Who reads emails and words explanations">Reader <b>{view.mode.model}</b></span>
          <span>run <b>{view.run}</b></span>
        </span>
        <button className="btn d-reset" disabled={!!busy} onClick={() => run({ action: "reset" }, "Reset")}>Reset</button>
      </header>

      <div className={`d-progress${busy ? " on" : ""}`} aria-hidden />

      <nav className="d-steps" aria-label="Demo steps">
        {steps.map((s) => (
          <button key={s.n} className={`d-step${s.done ? " done" : ""}`} disabled={!s.enabled || !!busy} onClick={() => run(s.body, s.label)}>
            <span className="mono n">{s.n}</span>
            <span className="l">{s.label}</span>
            <span className="mono s">{busy === s.label ? `running · ${secs}s` : s.done ? "done" : s.sub}</span>
          </button>
        ))}
        <div className="d-needs mono">
          {needs ? <><b>{needs}</b> waiting for you</> : view.audits ? "nothing waiting" : ""}
        </div>
      </nav>
      </div>

      {error && <div className="d-banner wrong" role="alert">{error}</div>}
      {notice && <div className="d-banner" role="status">{notice}</div>}

      {!view.seeded ? (
        <section className="d-empty">
          <Tally id="empty" wrong="" fixed="no audit has run yet" play={false} />
          <h1>No inquiry yet.</h1>
          <p>
            Seeding puts one month of {view.company} into Airwallex {view.mode.airwallex === "sandbox" ? "sandbox" : "(offline mock)"}: a funding
            deposit, two FX conversions, five payouts, one inbox. Six of those are planted not to tally with the books
            {view.mode.airwallex === "sandbox" ? ", and the sandbox's real payout fees add a few more" : ""}. Nothing tells the agent which.
          </p>
          <button className="btn solid" disabled={!!busy} onClick={() => run({ action: "seed" }, steps[0].label)}>
            {busy ? `Seeding · ${secs}s` : "Seed the sandbox"}
          </button>
          {live && (
            <ol className="d-live" aria-live="polite">
              {live.trace.slice(-5).map((t, i) => (
                <li key={live.trace.length - 5 + i}>{t.text}</li>
              ))}
              {live.activity && <li className="now">{live.activity}</li>}
            </ol>
          )}
        </section>
      ) : (
        <div className="d-grid">
          {/* ---------- Left: pockets and the queue ---------- */}
          <aside className="d-left">
            <h2 className="mono d-h">Pockets</h2>
            {pockets.length === 0 && <p className="dim d-small">Run the audit to lay the books against the bank.</p>}
            {pockets.map((p) => {
              const o = view.pockets.opening.find((x) => x.currency === p.currency);
              const tallies = Math.abs(p.variance) < 0.005;
              return (
                <div key={p.currency} className="d-pocket">
                  <div className="d-pocket-head">
                    <span className="cur">{p.currency}</span>
                    <span className={`mono ${tallies ? "settled" : "ember"}`}>{tallies ? "tallies" : `gap ${fmt(p.variance, p.currency)}`}</span>
                  </div>
                  <dl>
                    <dt>Airwallex</dt>
                    <dd className="num">{fmt(p.bank, p.currency)}</dd>
                    <dt>Books</dt>
                    <dd className="num">{fmt(p.books, p.currency)}</dd>
                  </dl>
                  {o && o.variance !== 0 && (
                    <p className="mono d-small dim">
                      audit 1 gap {fmt(o.variance, o.currency)} · explained {fmt(o.explained, o.currency)} · residual {fmt(o.residual, o.currency)}
                    </p>
                  )}
                </div>
              );
            })}

            <h2 className="mono d-h">Breaks</h2>
            {queue.length === 0 && <p className="dim d-small">None found yet.</p>}
            <ul className="d-queue">
              {queue.map(({ b, s }) => (
                <li key={b.id}>
                  <button className={`d-item ${s.key}${selected === b.id ? " sel" : ""}`} onClick={() => setSelected(b.id)}>
                    <span className="row">
                      <span className="mono id">{b.id.replace("BRK-", "")}</span>
                      <span className={`chip ${s.key}`}>{s.text}</span>
                    </span>
                    <span className="t">{b.title}</span>
                  </button>
                </li>
              ))}
            </ul>

            {plans.length > 0 && <h2 className="mono d-h">Payments and plans</h2>}
            <ul className="d-queue">
              {plans.map((d) => {
                const s = statusOf(true, d);
                return (
                  <li key={d.id}>
                    <button className={`d-item ${s.key}${selected === d.breakId ? " sel" : ""}`} onClick={() => setSelected(d.breakId)}>
                      <span className="row">
                        <span className="mono id">{d.breakId}</span>
                        <span className={`chip ${s.key === "open" ? "holding" : s.key}`}>{s.key === "open" ? "proposed" : s.text}</span>
                      </span>
                      <span className="t">{d.chosen.label}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </aside>

          {/* ---------- Center: the autopsy of one break ---------- */}
          <main className="d-center">
            {!selected && <p className="dim">Run the audit, then pick a break.</p>}
            {selected && (
              <>
                <div className="d-title">
                  <span className="mono dim">{selected}</span>
                  <h1>
                    {sel?.title ??
                      (selected.startsWith("PLAN-")
                        ? "Funding for next week's EUR batch"
                        : selected.startsWith("OBL-")
                          ? `${selected.slice(4)} to ${selDecision?.chosen.counterparty}, due this week`
                          : selDecision?.chosen.label)}
                  </h1>
                  {sel && (
                    <span className="mono d-small dim">
                      {sel.variance !== 0 && <>gap {fmt(sel.variance, sel.currency)} · </>}
                      {sel.exposureUsd > 0 && <>at stake {fmt(sel.exposureUsd, "USD")} · </>}
                      {view.openBreaks.includes(sel.id) ? "still open in the latest audit" : "cleared in the latest audit"}
                    </span>
                  )}
                </div>

                {selDiag && (
                  <section className="d-block" key={selDiag.breakId}>
                    <div className="d-block-head">
                      <h2 className="mono d-h">Cause</h2>
                      <Meter value={selDiag.confidence} />
                    </div>
                    {selDiag.ruledOut.length > 0 && (
                      <ol className="d-ruled" aria-label="Ruled out">
                        {selDiag.ruledOut.map((r, i) => (
                          <li key={r.theory} style={{ ["--d" as string]: `${(0.15 + i * 0.22).toFixed(2)}s` }}>
                            <s className="t">{r.theory}</s>
                            <span className="w">{r.why}</span>
                          </li>
                        ))}
                      </ol>
                    )}
                    <p className="d-cause" style={{ ["--d" as string]: `${(0.3 + selDiag.ruledOut.length * 0.22).toFixed(2)}s` }}>
                      {selDiag.causeLabel}
                    </p>
                    <p className="d-explain">
                      {selDiag.explanation}{" "}
                      <span className="mono d-tag">worded by {selDiag.explainedBy === "claude" ? "Claude" : "rules"}</span>
                    </p>
                    <ol className="d-chain">
                      {selDiag.chain.map((c, i) => {
                        const ev = evidence(c.evidenceId);
                        return (
                          <li key={i}>
                            <span className="fact">{c.fact}</span>
                            <span className={`mono src ${ev?.source ?? ""}`} title={ev?.summary}>
                              {ev?.source ?? "evidence"} · weight {ev?.weight.toFixed(2) ?? "n/a"}
                            </span>
                          </li>
                        );
                      })}
                    </ol>
                    {selDiag.counterfactual && (
                      <div className="d-cf">
                        <span className="mono dim">Counterfactual replay</span>
                        <p className="q">{selDiag.counterfactual.question}</p>
                        <p className="mono d-small dim">{selDiag.counterfactual.intervention}</p>
                        <div className="pair">
                          <div>
                            <span className="mono dim">{selDiag.counterfactual.actual.label}</span>
                            <b className={MONEY.test(selDiag.counterfactual.actual.value) ? "num" : ""}>{selDiag.counterfactual.actual.value}</b>
                          </div>
                          <div>
                            <span className="mono dim">{selDiag.counterfactual.replayed.label}</span>
                            <b className={MONEY.test(selDiag.counterfactual.replayed.value) ? "num" : ""}>{selDiag.counterfactual.replayed.value}</b>
                          </div>
                        </div>
                      </div>
                    )}
                  </section>
                )}

                {selDecision && (
                  <section className="d-block">
                    <div className="d-block-head">
                      <h2 className="mono d-h">Decision r{selDecision.revision}</h2>
                      <span className={`chip ${statusOf(true, selDecision).key}`}>{statusOf(true, selDecision).text}</span>
                    </div>
                    <div className="d-chosen">
                      <span className="mono kinds">
                        <b>{selDecision.chosen.kind.replace(/_/g, " ")}</b> on {selDecision.chosen.rail}
                      </span>
                      <p className="label">{selDecision.chosen.label}</p>
                      <dl>
                        <dt>amount</dt>
                        <dd className="num">{fmt(selDecision.chosen.amount, selDecision.chosen.currency)}</dd>
                        <dt>expected cost</dt>
                        <dd className="num">{fmt(selDecision.chosen.expectedCostUsd, "USD")}</dd>
                        <dt>risk</dt>
                        <dd className="num">{(selDecision.chosen.risk * 100).toFixed(0)}%</dd>
                        <dt>time</dt>
                        <dd className="num">{selDecision.chosen.etaHours < 1 ? "minutes" : `${selDecision.chosen.etaHours}h`}</dd>
                        <dt>autonomy</dt>
                        <dd className="num">
                          {fmt(selDecision.autonomyLimitUsd, "USD")} at confidence {selDecision.confidence.toFixed(2)}
                        </dd>
                      </dl>
                      {selDecision.executeOn && <p className="mono d-small dim">runs on {selDecision.executeOn}</p>}
                      {selDecision.result && <p className="d-result">{selDecision.result}</p>}
                    </div>

                    {selDecision.status === "awaiting_approval" && (
                      <div className="d-approve">
                        <div className="why">
                          <span className="mono">Needs a person</span>
                          <p>{selDecision.approvalReason}</p>
                        </div>
                        <dl>
                          {Object.entries(selDecision.bindingTerms).map(([k, v]) => (
                            <div key={k} className="term">
                              <dt>{k}</dt>
                              <dd>{k === "evidence" ? String(v).split(",").filter(Boolean).map((e) => e.slice(0, 11) + "…").join(", ") : String(v)}</dd>
                            </div>
                          ))}
                        </dl>
                        <div className="hash mono">
                          <span>binding</span>
                          <b>{selDecision.binding}</b>
                        </div>
                        <div className="acts">
                          <button className="btn d-sign" disabled={!!busy} onClick={() => run({ action: "approve", decisionId: selDecision.id, binding: selDecision.binding }, "Approve")}>
                            Approve these exact terms
                          </button>
                          <button
                            className="d-link mono"
                            disabled={!!busy}
                            onClick={() => run({ action: "approve", decisionId: selDecision.id, binding: selDecision.binding.slice(0, -1) + (selDecision.binding.endsWith("0") ? "1" : "0") }, "Approve")}
                          >
                            test: sign a different hash
                          </button>
                        </div>
                      </div>
                    )}

                    {selDecision.rejected.length > 0 && (
                      <div className="d-rejected">
                        <span className="mono dim">Considered and rejected</span>
                        {selDecision.rejected.map((r, i) => (
                          <div key={i} className="opt">
                            <span className="mono k">{r.kind.replace(/_/g, " ")} · {r.rail}</span>
                            <span className="l">{r.label}</span>
                            <span className="w">{r.why}</span>
                          </div>
                        ))}
                      </div>
                    )}

                    {sel && sel.entryIds[0]?.startsWith("INV-") && livePayment(sel.entryIds[0]) && (
                      <div className="d-resend">
                        <span className="mono dim">What if someone sends it again by hand?</span>
                        <button className="btn" disabled={!!busy} onClick={() => run({ action: "resend", invoice: sel.entryIds[0] }, "Resend")}>
                          Try a manual resend of {sel.entryIds[0]}
                        </button>
                      </div>
                    )}
                  </section>
                )}
              </>
            )}
          </main>

          {/* ---------- Right: what happened ---------- */}
          <aside className="d-right" ref={rightPane}>
            <div className="d-tabs mono" role="tablist">
              {(["trace", "changes", "ledger", "drafts", "rules"] as Tab[]).map((t) => (
                <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
                  {t}
                  {t === "changes" && view.diffs.length ? <b>{view.diffs.length}</b> : null}
                  {t === "drafts" && view.drafts.length ? <b>{view.drafts.length}</b> : null}
                  {t === "rules" && view.rules.length ? <b>{view.rules.length}</b> : null}
                </button>
              ))}
            </div>

            <div className="d-pane">
              {tab === "trace" && (
                <ol className="d-trace">
                  {trace.map((t, i) => (
                    <li key={i} className={t.stage}>
                      <span className="mono st">{t.stage}</span>
                      <span className="tx">{t.text}</span>
                    </li>
                  ))}
                  {live?.activity && (
                    <li className="now" aria-live="polite">
                      <span className="mono st">now</span>
                      <span className="tx">{live.activity}</span>
                    </li>
                  )}
                </ol>
              )}

              {tab === "changes" && (
                <div className="d-diffs">
                  {view.diffs.length === 0 && <p className="dim d-small">Inject new evidence to see which decisions it changes.</p>}
                  {[...view.diffs].reverse().map((d) => (
                    <div key={d.evidenceId} className="d-diff">
                      <span className="mono dim">new evidence</span>
                      <h3>{d.evidenceLabel}</h3>
                      {d.changes.map((c) => (
                        <button key={c.breakId} className="d-change" onClick={() => setSelected(c.breakId)}>
                          <span className="mono id">{c.breakId}</span>
                          <span className="from">{c.before.action}{c.before.approval ? " · needs a person" : ""}</span>
                          <span className="to">{c.after.action}{c.after.approval ? " · needs a person" : ""}</span>
                        </button>
                      ))}
                      <p className="mono d-small dim">
                        {d.rechecked.length} rechecked, unchanged · {d.untouched.length} untouched
                      </p>
                    </div>
                  ))}
                </div>
              )}

              {tab === "ledger" && (
                <div className="d-ledger">
                  <h3 className="mono d-h">Transfers</h3>
                  {view.ledger.transfers.map((t) => (
                    <div key={t.id} className={`lrow ${["CANCELLED"].includes(t.status) ? "dead" : ""}`}>
                      <span className="mono">{t.ref}</span>
                      <span>{t.invoice} · {fmt(t.amount, t.currency)} {t.method}{t.fee ? ` + fee ${fmt(t.fee, t.currency)}` : ""}</span>
                      <span className="mono path">{t.path.join(" → ")}{t.failure ? ` · ${t.failure}` : ""}</span>
                    </div>
                  ))}
                  <h3 className="mono d-h">Conversions</h3>
                  {view.ledger.conversions.map((c) => (
                    <div key={c.id} className="lrow">
                      <span className="mono">{c.plan}</span>
                      <span>bought {c.buy} for {c.sell}</span>
                    </div>
                  ))}
                  <h3 className="mono d-h">Deposits</h3>
                  {view.ledger.deposits.map((d) => (
                    <div key={d.id} className="lrow">
                      <span>{fmt(d.amount, d.currency)}</span>
                      <span className="mono path">{d.payer}</span>
                    </div>
                  ))}
                  <h3 className="mono d-h">Journal written by Autopsy</h3>
                  {view.journal.length === 0 && <p className="dim d-small">Nothing yet.</p>}
                  {view.journal.map((j) => (
                    <div key={j.id} className="lrow">
                      <span className="mono">{j.id} {j.kind}</span>
                      <span>{fmt(j.amount, j.currency)} · {j.memo}</span>
                    </div>
                  ))}
                </div>
              )}

              {tab === "drafts" && (
                <div className="d-drafts">
                  <p className="mono d-small dim">Drafts only. Autopsy sends nothing to a supplier or customer.</p>
                  {view.drafts.map((d) => (
                    <div key={d.id} className="d-draft">
                      <span className="mono dim">to {d.to}</span>
                      <h3>{d.subject}</h3>
                      <pre>{d.body}</pre>
                    </div>
                  ))}
                </div>
              )}

              {tab === "rules" && (
                <div className="d-rules">
                  {view.rules.length === 0 && <p className="dim d-small">No rules learned yet.</p>}
                  {view.rules.map((r) => (
                    <div key={r.id} className="d-rule">
                      <span className="mono id">{r.id}</span>
                      <p>{r.text}</p>
                      <span className="mono d-small dim">learned from {r.learnedFrom} · applies to {r.appliesTo}</span>
                    </div>
                  ))}
                  <h3 className="mono d-h">Metal payouts</h3>
                  {view.metalPayouts.length === 0 && <p className="dim d-small">None. Metal is {view.mode.metal}.</p>}
                  {view.metalPayouts.map((m) => (
                    <div key={m.paymentId} className="d-rule">
                      <span className="mono id">{m.outcome}</span>
                      <p>
                        {fmt(m.amount, "USD")}
                        {m.onChain !== undefined && <> as {m.onChain.toFixed(2)} *USDZ (testnet, scaled)</>} to {m.payee}
                      </p>
                      <span className="mono d-small dim">
                        payment id {m.paymentId}
                        {m.transaction && (
                          <> · {m.explorer ? <a href={m.explorer} target="_blank" rel="noreferrer">tx {m.transaction.slice(0, 18)}…</a> : `tx ${m.transaction.slice(0, 18)}…`}</>
                        )}
                        {" · "}{m.detail}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}

