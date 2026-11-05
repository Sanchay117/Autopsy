import Image from "next/image";
import Link from "next/link";
import { Count } from "@/components/Count";
import { Embers } from "@/components/Embers";
import { Reveal } from "@/components/Reveal";
import { Scramble } from "@/components/Scramble";
import { Tally } from "@/components/Tally";
import { fmt } from "@/lib/engine/money";
import { POLICY } from "@/lib/engine/policy";
import { preview } from "@/lib/engine/preview";
import type { Decision } from "@/lib/engine/types";
import turner from "@/public/turner-1834.jpg";

export const dynamic = "force-dynamic";

const PAINTING_ALT =
  "J. M. W. Turner, The Burning of the Houses of Lords and Commons, 16 October 1834: the palace in flames across the Thames, crowds on the bank, the fire reflected in the river.";

const NOTCH_CODE = [
  { w: 40, what: "The thickness of a palm", val: "£1,000" },
  { w: 24, what: "The breadth of a thumb", val: "£100" },
  { w: 14, what: "The breadth of a little finger", val: "£20" },
  { w: 7, what: "A swollen barleycorn", val: "£1" },
  { w: 0, what: "A cut that takes no wood away", val: "1d" },
];

// What the Privy Council committee heard between 22 October and 8 November 1834.
const THEORIES_1834 = ["The plumbers", "The coffee-house servants", "A gas explosion", "Arson"];

// Recorded runs on the real rails (README, Status). The Metal transaction is public; sandbox objects stay private to the account.
const METAL_TX = "0xc6bbcaa26792c1937faf28af6d75a8512c73cc82ddc6a770a3680c43775690a8";
const PROOF = [
  {
    rail: "Airwallex sandbox",
    what: "The six breaks seeded with real simulation calls, then the audit, all three pieces of evidence and the approvals. Every pocket closed at zero variance and zero residual.",
    link: "API 2025-02-14",
  },
  {
    rail: "Metal testnet",
    what: "INV-2044's replacement, USD 4,532.15, settled as 4.53 *USDZ under a mandate that pays only Brennholz. mandate verify passes all four checks.",
    link: `tx ${METAL_TX.slice(0, 6)}…${METAL_TX.slice(-4)}`,
    href: `https://testnet.metalntwx.com/tx/${METAL_TX}`,
  },
];

const AIRWALLEX_CALLS = [
  ["POST", "/api/v1/transfers/create"],
  ["POST", "/api/v1/transfers/{id}/cancel"],
  ["POST", "/api/v1/fx/conversions/create"],
  ["POST", "/api/v1/simulation/transfers/{id}/transition"],
  ["POST", "/api/v1/simulation/deposit/create"],
  ["GET", "/api/v1/transfers?request_id=…"],
];

/** Place in a staggered list, read by the [data-rise] motion. */
const nth = (i: number) => ({ ["--n" as string]: i }) as React.CSSProperties;

/** Strike timing for the inquiry: each theory, then the verdict. */
const STRIKE_GAP = 0.42;
const timing = (start: number, count: number) => ({
  item: (i: number) => `${(start + i * STRIKE_GAP).toFixed(2)}s`,
  verdict: `${(start + count * STRIKE_GAP + 0.25).toFixed(2)}s`,
  end: start + count * STRIKE_GAP + 0.25,
});

const longDate = (iso: string) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

// Keeps ids like AR-7790 and R-FEE on one line instead of splitting at the hyphen.
function Ids({ text }: { text: string }) {
  return (
    <>
      {text.split(/\b([A-Z]{1,4}-[A-Z0-9][A-Z0-9-]*)\b/).map((part, i) =>
        i % 2 ? <span key={i} className="nowrap">{part}</span> : part,
      )}
    </>
  );
}

function Head({ no, title, children }: { no: string; title: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="sec-head">
      <span className="sec-no mono">{no}</span>
      <div>
        <span className="sec-rule" />
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

export default async function Home() {
  const { first, final } = await preview();
  const dec = (breakId: string) => final.decisions.find((d) => d.breakId === breakId);
  const diag = (breakId: string) => final.diagnoses.find((d) => d.breakId === breakId);
  const step = (stage: string, match?: string) =>
    first.trace.find((t) => t.stage === stage && (!match || t.text.includes(match)))?.text ?? "";

  const fee = first.breaks.find((b) => b.kind === "FEE_NOT_FUNDED")!;
  const feeDiag = first.diagnoses.find((d) => d.breakId === fee.id)!;
  const flight = diag(first.breaks.find((b) => b.kind === "IN_FLIGHT_DISPUTED")!.id)!;
  const signed = final.decisions.filter((d) => d.approved);
  const live = (inv: string) => final.ledger.transfers.filter((t) => t.invoice === inv && ["PROCESSING", "SENT", "PAID"].includes(t.status)).length;
  const doubles = [...new Set(final.ledger.transfers.map((t) => t.invoice))].filter((inv) => live(inv) > 1).length;
  const residuals = final.pockets.latest.map((p) => fmt(p.residual, p.currency)).join(" · ");
  const receipt = final.decisions.find((d) => d.breakId === "BRK-RET-INV-2044")!;
  const payId = final.decisions.find((d) => d.breakId === "OBL-INV-2050")?.result?.match(/apx-[\w-]+/)?.[0] ?? "";
  const floorWhy = first.decisions.find((d) => d.breakId === "OBL-INV-2050")?.rejected.find((r) => r.kind === "PAY")?.why ?? "";

  const then = timing(0.5, THEORIES_1834.length);
  const now = timing(then.end + 0.7, feeDiag.ruledOut.length);

  const tape = final.trace
    .filter((t) => ["act", "diagnose", "learn"].includes(t.stage))
    .map((t) => ({ stage: t.stage, text: t.text.replace(/^DEC-/, "") }));

  const who = (d?: Decision) => (d?.approvalReason ? "person" : "agent");
  const fixText = (d?: Decision) => {
    if (!d) return "";
    if (d.status === "superseded") {
      const n = final.diffs.findIndex((e) => e.changes.some((c) => c.breakId === d.breakId));
      return n < 0 ? `${d.chosen.label}. Superseded` : `${d.chosen.label}. Replaced after evidence ${n + 1}: ${final.diffs[n].evidenceLabel}`;
    }
    return d.result ?? d.chosen.label;
  };

  return (
    <>
      <Reveal />
      <header className="bar">
        <div className="wrap">
          <Link href="/" className="brand mono">
            <Image src="/mark.svg" alt="" width={26} height={26} priority />
            Autopsy
          </Link>
          <nav className="mono">
            <a href="#inquiry"><b>01</b>Inquiry</a>
            <a href="#tally"><b>02</b>Tally</a>
            <a href="#method"><b>04</b>Method</a>
            <a href="#breaks"><b>05</b>Breaks</a>
            <a href="#safety"><b>07</b>Safety</a>
            <Link href="/audit" className="btn">Open the audit</Link>
          </nav>
        </div>
      </header>

      <main>
        <section className="hero">
          <div className="hero-art">
            <Image src={turner} alt={PAINTING_ALT} fill priority sizes="130vw" placeholder="blur" />
          </div>
          <Embers count={24} from={44} to={96} />
          <div className="wrap">
            <div className="hero-copy">
              <p className="eyebrow mono">Reconciliation agent for Airwallex</p>
              <h1 className="wordmark" aria-label="Autopsy">
                {[..."Autopsy"].map((c, i) => (
                  <span key={i} className="l" aria-hidden style={{ ["--i" as string]: i }}>{c}</span>
                ))}
              </h1>
              <p className="hero-sub">
                Your books and your bank disagree. <em>Autopsy finds out why.</em>
              </p>
              <div className="case" aria-label={`Last night: ${fee.currency} pocket ${fmt(-fee.variance, fee.currency)} short. Ruled out: ${feeDiag.ruledOut.map((r) => r.theory.toLowerCase()).join(", ")}. Cause: the fees.`}>
                <span className="case-q mono" aria-hidden>Last night · {fee.currency} pocket {fmt(-fee.variance, fee.currency)} short</span>
                <p className="case-line" aria-hidden>
                  {feeDiag.ruledOut.map((r, i) => (
                    <span key={r.theory} className="case-t" style={{ ["--d" as string]: `${(1.7 + i * 0.3).toFixed(2)}s` }}>{r.theory}</span>
                  ))}
                  <b className="case-v" style={{ ["--d" as string]: `${(1.95 + feeDiag.ruledOut.length * 0.3).toFixed(2)}s` }}>The fees.</b>
                </p>
              </div>
              <p className="hero-body">
                It reads every transfer, return and fee in Airwallex, fixes the real cause without paying twice, and waits for your
                signature on anything over its limit.
              </p>
              <div className="hero-actions">
                <Link href="/audit" className="btn solid">Open the live audit <span className="arrow">→</span></Link>
                <a href="#inquiry" className="btn">How it finds the cause</a>
              </div>
            </div>
            <div className="hero-foot">
              <div className="stats mono">
                <span><b>{first.breaks.length}</b> breaks found</span>
                <span><b>{first.diagnoses.length}</b> causes proven</span>
                <span>residual <b>{residuals}</b></span>
                <span><b>{doubles}</b> paid twice</span>
                <span><b>{signed.length}</b> signed by a person</span>
                <span className="tag">{final.mode.airwallex} run · this server</span>
              </div>
              <p className="credit mono">
                <i>J. M. W. Turner, The Burning of the Houses of Lords and Commons, 16 October 1834</i> (1835). Cleveland Museum of Art, CC0.
              </p>
            </div>
          </div>
        </section>

        <div className="tape mono" aria-label="Steps from a real run of the engine">
          <div className="tape-label">Live run, {final.mode.airwallex}</div>
          <div className="tape-track">
            <div className="tape-run">
              {[0, 1].map((k) => (
                <span key={k} aria-hidden={k === 1}>
                  {tape.map((t, i) => (
                    <span key={i}>
                      <b>{t.stage}</b> {t.text}
                      <i />
                    </span>
                  ))}
                </span>
              ))}
            </div>
          </div>
        </div>

        <section className="sec inquiry" id="inquiry" data-reveal>
          <div className="wrap">
            <Head no="01 / Inquiry" title={<>In 1834 everyone had a theory. The committee wanted <em>a cause</em>.</>}>
              <p className="sec-intro">
                Parliament burned down on 16 October 1834. Six days later a committee of the Privy Council sat to find out why, and it
                took seventeen days to rule out the wrong answers. Autopsy holds the same hearing for every gap between your books and
                your bank, and shows the evidence for each answer it rules out.
              </p>
            </Head>
            <div className="hearings">
              <div className="hearing">
                <span className="when mono">Privy Council · 22 October to 8 November 1834</span>
                <h3 className="q">Why did Parliament burn?</h3>
                <ol className="theories">
                  {THEORIES_1834.map((t, i) => (
                    <li key={t} style={{ ["--d" as string]: then.item(i) }}>
                      <span className="t">{t}</span>
                    </li>
                  ))}
                </ol>
                <p className="verdict" style={{ ["--d" as string]: then.verdict }}>The tallies.</p>
                <p className="finding" style={{ ["--d" as string]: then.verdict }}>
                  The Exchequer&apos;s old tally sticks, burned in the two furnaces under the House of Lords. The flues ran beneath the
                  chamber floor, and they overheated.
                </p>
              </div>
              <div className="hearing">
                <span className="when mono">Autopsy · audit of {longDate(final.auditDate)} · {final.mode.airwallex} run</span>
                <h3 className="q">Why is the {fee.currency} pocket {fmt(-fee.variance, fee.currency)} short?</h3>
                <ol className="theories">
                  {feeDiag.ruledOut.map((r, i) => (
                    <li key={r.theory} style={{ ["--d" as string]: now.item(i) }}>
                      <span className="t">{r.theory}</span>
                      <small>{r.why}</small>
                    </li>
                  ))}
                </ol>
                <p className="verdict" style={{ ["--d" as string]: now.verdict }}>The fees.</p>
                <p className="finding" style={{ ["--d" as string]: now.verdict }}>
                  <b>{feeDiag.causeLabel}.</b> Replayed with the fees funded, the lowest {fee.currency} balance is{" "}
                  <span className="num">{feeDiag.counterfactual?.replayed.value}</span> instead of{" "}
                  <span className="num">{feeDiag.counterfactual?.actual.value}</span>.
                </p>
              </div>
            </div>
          </div>
        </section>

        <section className="sec" id="tally" data-reveal>
          <div className="wrap">
            <Head no="02 / Tally" title={<>What burned was the Exchequer&apos;s <em>ledger</em>.</>} />
            <div className="two">
              <div className="prose">
                <p>
                  From the twelfth century the Exchequer recorded each payment by cutting notches into a hazel stick, then splitting it
                  lengthwise. Each side kept one half. The split followed the grain, so no other piece of wood would ever fit.
                </p>
                <p>
                  At settlement the halves were laid together. If every notch lined up, the account tallied. The size of a notch was its
                  value, written down around 1180 in the <i>Dialogue of the Exchequer</i>. The system was abolished in 1826, and the
                  sticks left over were what went into the furnaces in 1834.
                </p>
                <p className="quiet">
                  Autopsy keeps the method. Your books are one half and Airwallex is the other. Every notch has to fit, and when one does
                  not, it says which, why, and what it will cost to fix.
                </p>
              </div>
              <div className="code">
                {NOTCH_CODE.map((n, i) => (
                  <div key={n.val} className="code-row" data-rise style={nth(i)}>
                    <svg width="80" height="40" viewBox="0 0 80 40" aria-hidden>
                      <rect x="0" y="8" width="80" height="24" fill="var(--hazel)" />
                      {n.w ? (
                        <polygon points={`${40 - n.w / 2},8 40,${8 + Math.max(5, n.w * 0.45)} ${40 + n.w / 2},8`} fill="var(--umber)" />
                      ) : (
                        <line x1="40" x2="40" y1="8" y2="22" stroke="var(--umber)" strokeWidth="1.5" />
                      )}
                    </svg>
                    <span className="what">{n.what}</span>
                    <span className="val">{n.val}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="tally-wrap">
              <Tally
                wrong={`${fmt(-fee.variance, fee.currency)} · SWIFT fees never funded`}
                fixed={`R-FEE learned · ${fee.currency} residual ${fmt(0, fee.currency)}`}
              />
            </div>
          </div>
        </section>

        <section className="sec" id="replay" data-reveal>
          <div className="wrap">
            <Head no="03 / Replay" title={<>A missing payment is not a reason to <em>pay again</em>.</>} />
            <div className="turn">
              <div className="old" data-rise>
                <span className="mono">The usual move</span>
                <h3>The supplier says it never arrived, so send it again.</h3>
                <p>If the first payment was only slow, the supplier is now paid twice and someone spends a month recovering it across a border.</p>
              </div>
              <div className="new" data-rise style={nth(2)}>
                <span className="mono flame">What Autopsy does</span>
                <h3>Replay the account before touching it.</h3>
                <p>
                  Brennholz wrote that INV-2044 never arrived. Airwallex shows it SENT six days ago with no failure. Autopsy replays the EUR
                  pocket both ways:
                </p>
                <div className="replay">
                  <div>
                    <span>{flight.counterfactual!.actual.label}</span>
                    <span className="big"><Count value={flight.counterfactual!.actual.value} /></span>
                  </div>
                  <div>
                    <span>{flight.counterfactual!.replayed.label}</span>
                    <span className="big worse"><Count value={flight.counterfactual!.replayed.value} ms={2000} /></span>
                  </div>
                </div>
                <p style={{ marginTop: 20 }}>
                  So it waits, requests a trace, drafts a reply, and the duplicate lock refuses a second payment while the first is live.
                  When the bank later returns the transfer, the same lock lets exactly one replacement through.
                </p>
              </div>
            </div>
          </div>
        </section>

        <section className="sec" id="method" data-reveal>
          <div className="wrap">
            <Head no="04 / Method" title={<>Five steps, <em>every night</em>.</>} />
            <div className="steps">
              {[
                ["Detect", "Lays each pocket's bank balance against the books and splits the gap into breaks. Anything unexplained is reported as residual, never hidden.", step("detect", "USD pocket")],
                ["Diagnose", "Rules out the obvious theories with evidence, then proves the cause by replaying the pocket with one event changed.", step("diagnose", "DUP")],
                ["Decide", "Prices every fix by cost, chance of leaving money wrong, and time. Picks the cheapest safe one, inside limits written in code.", step("decide", "RET-INV-2039")],
                ["Act", "Cancels, converts, pays or journals through Airwallex, under a duplicate lock. Anything over its limit waits for a person.", step("act", "DUP")],
                ["Learn", "Turns a confirmed cause into a standing rule, so the same break cannot come back next week.", step("learn", "R-FEE")],
              ].map(([h, p, real], i) => (
                <div key={h} className="step" data-rise style={nth(i)}>
                  <span className="mono dim">0{i + 1}</span>
                  <h3>{h}</h3>
                  <p>{p}</p>
                  <span className="real">{real}</span>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="sec" id="breaks" data-reveal>
          <div className="wrap">
            <Head no="05 / Breaks" title={<>Six breaks, seeded into <em>real</em> payment rails.</>}>
              <p className="sec-intro">
                Harrow &amp; Finch Trading is invented. The transfers, conversions, returns and fees are Airwallex objects: sandbox, or an
                offline mock that follows the same documented rules. This table is the engine&apos;s own output from the run that served this
                page.
              </p>
            </Head>
            <div className="table-scroll">
              <table className="breaks">
                <thead>
                  <tr>
                    <th>Break</th>
                    <th>What does not fit</th>
                    <th>Proven cause</th>
                    <th>What it did</th>
                    <th>Who</th>
                  </tr>
                </thead>
                <tbody>
                  {first.breaks.map((b, i) => {
                    const d = diag(b.id);
                    const x = dec(b.id);
                    return (
                      <tr key={b.id} data-rise style={nth(i)}>
                        <td className="id">{b.id.replace("BRK-", "")}</td>
                        <td><Ids text={b.title} /></td>
                        <td className="cause">
                          <b>{d?.causeLabel}</b>
                          {d?.ruledOut.length ? (
                            <span className="ruled">
                              ruled out:{" "}
                              {d.ruledOut.map((r, i) => (
                                <span key={r.theory}>{i ? ", " : ""}<s>{r.theory.toLowerCase()}</s></span>
                              ))}
                            </span>
                          ) : null}
                          <span className="conf">confidence {d?.confidence.toFixed(2)}</span>
                        </td>
                        <td className="fix"><Ids text={fixText(x)} /></td>
                        <td><span className={`who ${who(x)}`}>{who(x)}</span></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="residual">
              {first.pockets.opening.filter((p) => p.variance !== 0).map((p, i) => (
                <div key={p.currency} data-rise style={nth(i)}>
                  <span className="mono dim">{p.currency} gap found</span>
                  <span className="big num"><Count value={fmt(p.variance, p.currency)} /></span>
                  <span className="mono dim">explained {fmt(p.explained, p.currency)} · residual {fmt(p.residual, p.currency)}</span>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="sec" id="evidence" data-reveal>
          <div className="wrap">
            <Head no="06 / Evidence" title={<>New facts change its mind, and only <em>where they should</em>.</>}>
              <p className="sec-intro">
                After the first audit, three things arrive. Each one revises the decisions it touches and leaves the rest exactly as they were.
              </p>
            </Head>
            <div className="evidence">
              {final.diffs.map((d, i) => (
                <div key={d.evidenceId} className="ev" data-rise style={nth(i * 2)}>
                  <span className="mono dim">Evidence {i + 1}</span>
                  <h3><Ids text={d.evidenceLabel} /></h3>
                  {d.changes.map((c) => (
                    <div key={c.breakId} className="change">
                      <span className="mono dim">{c.breakId}</span>
                      <span className="from"><Ids text={c.before.action} />{c.before.approval ? " (needs a person)" : ""}</span>
                      <span className="to"><Ids text={c.after.action} />{c.after.approval ? " (needs a person)" : ""}</span>
                    </div>
                  ))}
                  <span className="mono dim">{d.untouched.length + d.rechecked.length} other decisions left alone</span>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="sec" id="safety" data-reveal>
          <div className="wrap">
            <Head no="07 / Safety" title={<>Limits live in code. The model <em>never sees them</em>.</>} />
            <div className="two">
              <div>
                <p className="mono dim" style={{ marginBottom: 12 }}>Autonomy by confidence · policy {POLICY.version}</p>
                <table className="tiers">
                  <tbody>
                    {POLICY.autonomy.map((t, i) => (
                      <tr key={t.min} data-rise style={nth(i)}>
                        <td>confidence ≥ {t.min.toFixed(2)}</td>
                        <td>{t.limitUsd ? `moves up to ${fmt(t.limitUsd, "USD")} alone` : "every action needs a person"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="guard">
                  <div data-rise style={nth(0)}>
                    <span className="k mono">Duplicate lock</span>
                    <span>
                      One live payment per invoice. Before paying, it re-reads every earlier attempt from Airwallex. Request ids are
                      deterministic, like <span className="num">{payId}</span>, so a retry after a timeout finds the first payment instead of
                      sending another.
                    </span>
                  </div>
                  <div data-rise style={nth(1)}>
                    <span className="k mono">Reserve floor</span>
                    <span>The USD pocket never goes under {fmt(5_000, "USD")}. INV-2050 waited for its funding because paying it {floorWhy.charAt(0).toLowerCase() + floorWhy.slice(1)}.</span>
                  </div>
                  <div data-rise style={nth(2)}>
                    <span className="k mono">Second payments</span>
                    <span>Any replacement for an invoice goes to a person, whatever the confidence. So do new bank details and escalations.</span>
                  </div>
                  <div data-rise style={nth(3)}>
                    <span className="k mono">The model</span>
                    <span>
                      Claude reads emails into a fixed schema and words explanations. It never sees limits and never picks an action. An
                      account quoted in an email is never paid; only the vendor master is.
                    </span>
                  </div>
                  <div data-rise style={nth(4)}>
                    <span className="k mono">Messages</span>
                    <span>Every note to a supplier or customer is a draft. Nothing is sent.</span>
                  </div>
                </div>
              </div>
              <div>
                <p className="mono dim" style={{ marginBottom: 12 }}>An approval is bound to its exact terms</p>
                <div className="slot" data-reveal>
                  <div className="receipt">
                    <h4>{receipt.id.replace("DEC-", "")}</h4>
                    <dl>
                      {Object.entries(receipt.bindingTerms).map(([k, v]) => (
                        <div key={k} style={{ display: "contents" }}>
                          <dt>{k}</dt>
                          <dd>{k === "evidence" ? String(v).split(",").map((e) => e.slice(0, 11) + "…").join(", ") : String(v)}</dd>
                        </div>
                      ))}
                    </dl>
                    <div className="hash">
                      <span>binding</span>
                      <Scramble text={receipt.binding} delay={150} />
                    </div>
                    <p style={{ fontSize: 12.5, opacity: 0.75 }}>
                      sha-256 of the lines above. Change any one and the approval no longer applies; the agent re-reads the bank before it
                      acts on a signature.
                    </p>
                  </div>
                  </div>
              </div>
            </div>
          </div>
        </section>

        <section className="sec" id="rails" data-reveal>
          <div className="wrap">
            <Head no="08 / Rails" title={<>Two rails, <em>one lock</em>.</>} />
            <div className="rails">
              <div data-rise>
                <span className="mono dim">Airwallex · this run: {final.mode.airwallex}</span>
                <h3>Where the money is</h3>
                <div className="calls">
                  {AIRWALLEX_CALLS.map(([verb, path], i) => (
                    <span key={path} style={{ ["--i" as string]: i }}><b>{verb}</b>{path}</span>
                  ))}
                </div>
                <p className="dim" style={{ fontSize: 16 }}>
                  {final.mode.airwallex === "sandbox" ? "Breaks are seeded with real simulation calls" : "With sandbox keys, breaks are seeded with these simulation calls"}:
                  a PAID transfer returned with ACCOUNT_CLOSED, SWIFT fees that drain an unfunded pocket, a resubmission under a new
                  request id.{final.mode.airwallex === "sandbox" ? "" : " Without keys, an offline mock follows the same sandbox rules."}
                </p>
              </div>
              <div data-rise style={nth(2)}>
                <span className="mono dim">Metal · this run: {final.mode.metal}</span>
                <h3>Where a returned payment can go</h3>
                <div className="calls">
                  <span className="cmd"><b>$</b>metal-agent mandate pull --to … --payment-id INV-2044-r2</span>
                </div>
                <p className="dim" style={{ fontSize: 16 }}>
                  When a SWIFT payment comes back and the supplier has offered stablecoin settlement in writing, Autopsy can settle on
                  Metal instead. The mandate enforces the payee and cap on chain, and a payment id pays at most once.
                  {final.metalPayouts[0] ? ` In this run: ${fmt(final.metalPayouts[0].amount, "USD")} to ${final.metalPayouts[0].payee.slice(0, 10)}… (${final.mode.metal}).` : ""}
                </p>
              </div>
            </div>
            <div className="proof">
              <p className="mono dim proof-head">Run against the real rails · run 459674, 4 November 2026</p>
              {PROOF.map((p, i) => (
                <div key={p.rail} className="proof-row" data-rise style={nth(i)}>
                  <span className="mono flame">{p.rail}</span>
                  <p>{p.what}</p>
                  {p.href ? (
                    <a className="num" href={p.href} target="_blank" rel="noreferrer">{p.link} <span aria-hidden>↗</span></a>
                  ) : (
                    <span className="num dim">{p.link}</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="close" data-reveal>
          <div className="close-art" aria-hidden>
            <Image src={turner} alt="" fill sizes="100vw" />
          </div>
          <Embers count={16} from={8} to={92} />
          <div className="wrap">
            <h2>Every fire has a cause.</h2>
            <p>So does every gap in your books.</p>
            <Link href="/audit" className="btn solid">Open the live audit <span className="arrow">→</span></Link>
          </div>
        </section>
      </main>

      <footer>
        <div className="wrap">
          <p>
            Autopsy, built for the Airwallex Agentic Banking Hackathon, November 2026. Harrow &amp; Finch Trading and every supplier,
            customer, account and email shown are invented.
          </p>
          <p>
            Painting: J. M. W. Turner, <i>The Burning of the Houses of Lords and Commons, 16 October 1834</i>, 1835, oil on canvas.{" "}
            <a href="https://www.clevelandart.org/art/1942.647">Cleveland Museum of Art</a>, bequest of John L. Severance, CC0. The
            inquiry: <a href="https://en.wikipedia.org/wiki/Burning_of_Parliament">Burning of Parliament</a>. The tally: Richard
            FitzNigel, <i>Dialogus de Scaccario</i> (c. 1180);{" "}
            <a href="https://history.blog.gov.uk/2013/08/14/the-exchequer-a-chequered-history/">The Exchequer: a chequered history</a>.
          </p>
        </div>
      </footer>
    </>
  );
}
