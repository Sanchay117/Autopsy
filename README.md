# Autopsy

**A reconciliation agent for Airwallex that proves why the money went wrong, then fixes it without paying twice.**

Built for the Airwallex Agentic Banking Hackathon, November 2026.

- **Film:** [youtu.be/iGvJUqS1HSU](https://youtu.be/iGvJUqS1HSU), 3:28. One real run on the Airwallex sandbox and Metal testnet.
- **Live demo:** [autopsy-xrcq.onrender.com](https://autopsy-xrcq.onrender.com), on the offline mock. After a quiet spell the first visit can take a minute to wake.

Every night Autopsy lays a company's books against its Airwallex wallet, like the two halves of a split tally. Wherever a notch does not fit, it:

1. finds the cause, with every step tied to evidence;
2. replays the history with one event changed to test that cause;
3. picks the cheapest safe fix;
4. carries the fix out under a duplicate lock;
5. writes down a rule, so the same break does not come back.

Money only moves inside limits set in code. Anything above them waits for a person who signs the exact terms.

```bash
pnpm install
pnpm dev
```

Open http://localhost:3000 for the story and http://localhost:3000/audit for the live audit. No keys are needed: by default it runs on an offline mock that follows the sandbox's rules.

## The loop

| Step | What happens | Where |
| --- | --- | --- |
| Detect | Reads every transfer, conversion and deposit from Airwallex. Compares each currency pocket with the books, splits the gap into breaks and shows what is left unexplained. | `lib/engine/reconcile.ts` |
| Diagnose | Builds a chain from symptom to cause, each link tied to an Airwallex object or an email. Then it asks a counterfactual: replay the history with one event changed, and see whether the break disappears. | `lib/engine/diagnose.ts`, `replay.ts` |
| Decide | Prices every option (expected cost plus risk times exposure), drops anything the policy blocks, and sets autonomy from confidence. | `lib/engine/decide.ts`, `policy.ts` |
| Act | Carries out the chosen fix on Airwallex or Metal. Every payment goes through the duplicate lock. Messages are drafted, never sent. | `lib/engine/act.ts`, `lock.ts` |
| Learn | Turns a proven cause into a rule that changes later decisions, such as R-FEE ("fund every SWIFT payout with its fee"). | `lib/engine/learn.ts` |

## The six planted breaks

The seed puts a made-up company, Harrow & Finch Trading, into the sandbox with six things wrong. The first audit finds all six:

| Break | What does not fit | Proven cause | What Autopsy does |
| --- | --- | --- | --- |
| RET-INV-2039 | GBP payout to Harbour Print shows PAID, then fails | Beneficiary account closed (90701) | Reopens the invoice and drafts a request for new details. A person signs. Learns R-HOLD-V-HBR. |
| FEE-EUR | EUR pocket is EUR 25.70 short | The conversion bought the invoice total, not invoice plus two SWIFT fees | Books the fees and buys back the shortfall. Learns R-FEE. |
| DUP-INV-2047 | The same invoice was paid twice under two request ids | Manual resubmission | Cancels the second transfer before it leaves |
| FLT-INV-2044 | Supplier says "not received" for a payment still SENT | Still in flight | Waits 48 hours and drafts a reply. Counterfactual: paying again now would send EUR 8,025.70. |
| RCV-AR-7781 | A customer receipt is missing | Customer has not paid yet | Drafts a reminder, and holds INV-2050 so the reserve floor holds |
| FX-FXP-118 | Booked at the plan's rate, converted at the market rate | Rate moved since the plan | Books the FX gain |

Then three pieces of evidence arrive. Each one changes only the decisions it should:

- **E1, a deposit lands:** INV-2050 is now paid, and the receipt turns out USD 25 short. That gap is an intermediary bank charge, so it is written off.
- **E2, the bank returns INV-2044:** the supplier has offered stablecoin settlement in writing, so the replacement is proposed on Metal. A person must sign it.
- **E3, a customer email promises a partial payment later:** next week's EUR funding loses its forecast confidence and now needs a signature.

## Safety

- **Limits live in code, never in the prompt.** `lib/engine/policy.ts` sets autonomy by confidence:
  - 0.9 or more: up to USD 10,000.
  - 0.75 or more: up to USD 2,500.
  - 0.5 or more: up to USD 500.
  - Below 0.5: nothing.
- **Approvals are bound to exact terms.** The approver signs a sha-256 of the action, rail, amount, currency, counterparty, account, evidence and policy version. If any of those change, the signature no longer applies. Before acting on a signature, Autopsy re-reads the bank.
- **Duplicate lock.** An invoice can have only one live payment (PROCESSING, SENT or PAID).
  - Request ids are deterministic, so a retry after a timeout finds the first payment instead of creating another.
  - A manual "resend" button checks the lock and never sends.
- **People own the risky actions.** A second payment for the same invoice always goes to a person, whatever the confidence. So do new bank details and escalations.
- **Reserve floor.** The USD pocket never goes below USD 5,000.
- **The model reads, it does not decide.** Claude reads emails into a fixed schema and words the explanations. It never sees limits and never picks an action. An account quoted in an email is never paid; only the vendor master is.

## Where Claude is used

`lib/engine/read.ts` calls `claude-opus-5-5` through the Anthropic SDK with a zod output schema. It does two jobs:

- reading supplier and customer emails into claims (which invoice, what is claimed, any promised date or amount, any account quoted);
- writing the plain explanation for each diagnosis.

Results are cached, and a refusal or error falls back to rules. Without `ANTHROPIC_API_KEY`, the same steps run on rules, and the dashboard says which one worded each explanation.

## Metal (optional)

When a SWIFT payment comes back and the supplier has accepted stablecoin settlement in writing, Autopsy can settle on Metal instead (`lib/rails/metal.ts`).

- **Testnet:** runs `metal-agent mandate pull --payment-id <invoice>-r<n>`. The mandate enforces the payee and the cap on chain, and a payment id pays at most once.
- **Mock (default):** keeps the same at-most-once rule offline.
- **Off:** set `METAL_MODE=off` and Metal is never used.

To run it on testnet:

```bash
npm install -g @metalntwx/metal-agent@0.3.3
# add METAL_RPC_URL to .env.local: an endpoint from https://console-testnet.metalntwx.com
pnpm setup:metal                # creates a Metal account, funds it from the faucet, binds the mandate
METAL_MODE=testnet pnpm dev
```

`setup:metal` keeps its keys and the credential in `.autopsy/metal/`, which is git-ignored. The mandate it binds may pay only Brennholz's wallet from the vendor master, at most 10 *USDZ a payment and 90 *USDZ in all. Metal checks those limits on chain at every payment, not Autopsy.

The faucet grants 100 *USDZ at a time, so testnet settles a scaled amount: `METAL_SCALE` (0.001 by default) *USDZ per USD. The dashboard and the trace say so next to every testnet payout. The 10 *USDZ cap means an amount that was not scaled can never pay.

**Status:** the run in the film, run 459674 on 4 November 2026 with the sandbox. E2 settled INV-2044 for USD 4,532.15 as 4.53 *USDZ, payment id `INV-2044-r2-459674`, transaction [0xc6bb…90a8](https://testnet.metalntwx.com/tx/0xc6bbcaa26792c1937faf28af6d75a8512c73cc82ddc6a770a3680c43775690a8). `metal-agent mandate verify` passes all four checks for it: the mandate is bound, the credential matches it, its signatures hold, and the payment is inside its limits. After it the mandate had spent 13.59 of its 90 *USDZ.

## Running against the real sandbox

```bash
cp .env.example .env.local      # add AWX_CLIENT_ID and AWX_API_KEY
pnpm setup:sandbox              # finds or opens a USD Global Account, creates the five beneficiaries
pnpm feasibility                # checks the sandbox behaviours the audit relies on
AWX_MODE=sandbox pnpm dev
```

`setup:sandbox` writes `.autopsy/sandbox.json`, which is git-ignored. `feasibility` checks the following:

- A simulated deposit lands.
- USD buys EUR.
- A SWIFT payout charges its fee in EUR.
- A request id finds its payment.
- A reused request id cannot pay twice.
- A PAID transfer can still fail.
- A failed payout comes back without its fee.
- A PROCESSING payout can be cancelled.

**Status:** run end to end against a live sandbox account on 3 November 2026, and again on 4 November for the film (run 459674), with `AWX_API_VERSION=2025-02-14`. The seed, the audit, all three pieces of evidence and the approvals ran, and every pocket ended with zero variance and zero residual. What the sandbox does that the mock does not:

- Local payouts carry fees (GBP 2.24 on Faster Payments, USD 3.00 on ACH) and SWIFT costs EUR 13.41, not 12.85. The audit finds the seeded ones as extra fee breaks and books them, so a sandbox run shows more than six breaks. Payouts Autopsy makes itself book their fee at the time they are made.
- The sandbox's FX rate makes FXP-118 cost about USD 220 more than the plan, so the FX break is a loss rather than the mock's gain.
- Conversions live at `/api/v1/fx/conversions`. A new transfer stays SCHEDULED for about a second and refuses simulated moves until it is PROCESSING. It also refuses cancel while SCHEDULED and for a moment after turning PROCESSING. SWIFT payouts created close together sometimes return `fee_unknown`. The client waits or retries in each case, and never with a new request id.

## Deploying

The public demo runs in mock mode on [Render](https://render.com) from `render.yaml`. In Render choose New, then Blueprint, and pick this repo. It needs no keys. To have Claude read the emails, add `ANTHROPIC_API_KEY` on the service's Environment page.

Any host that keeps one Node 24 process running will do:

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm start      # listens on $PORT
```

Run a single instance, and not on a serverless host. The session lives in the process's memory, every visitor shares it, and some sandbox steps take 15 to 25 seconds. A live sandbox deploy also needs `.autopsy/sandbox.json` on the host, and Metal testnet needs the `metal-agent` CLI and the mandate credential. Keep a live deploy private: anyone who can open it can move sandbox money and spend the mandate.

## Checks

```bash
pnpm smoke    # the whole demo, printed step by step (on the sandbox when .env.local sets AWX_MODE=sandbox)
pnpm eval     # 200 shuffled runs with safety checks after every step
```

`pnpm eval` plays the three pieces of evidence in random orders. It mixes in things a person might do at the wrong moment:

- running the audit again;
- pressing resend;
- approving with a forged hash;
- replaying one decision's signature onto another;
- approving something already done.

Last run, 200 runs and 1,684 steps:

| Check | Result |
| --- | --- |
| Root cause matches what was planted | 1600/1600 |
| Invoices paid twice | 0 |
| Moves without the approval they needed | 0 |
| Forged approvals refused | 169/169 |
| Replayed signatures refused | 180/180 |
| Resends refused while a payment is live | 110/110 |
| Second approvals that did nothing | 176/176 |
| Runs ending with every residual at 0 | 200/200 |

To check the eval itself, the approval hash check was switched off briefly, and the eval failed on the first forged approval.

The eval measures one planted scenario under shuffled timing. It does not measure accuracy on breaks Autopsy has never seen.

## Layout

```
app/page.tsx              landing page, rendered from a real offline run
app/audit/                live dashboard: break queue, cause and counterfactual, approval cards, trace
app/api/audit/route.ts    seed, audit, inject evidence, approve, resend
lib/engine/               the agent: reconcile, diagnose, replay, decide, act, lock, learn, read, policy
lib/rails/airwallex/      one interface, a sandbox client and an offline mock
lib/rails/metal.ts        testnet CLI, mock and off
scripts/                  smoke, eval, setup-sandbox, setup-metal, feasibility
```

## Credits

The site is built around J. M. W. Turner, *The Burning of the Houses of Lords and Commons, 16 October 1834* (1835), oil on canvas, [Cleveland Museum of Art 1942.647](https://www.clevelandart.org/art/1942.647), bequest of John L. Severance, released under CC0. The palette is sampled from it. Parliament burned because the Exchequer's old tally sticks were fed into the furnaces under the House of Lords; a Privy Council committee heard the theories (plumbers, coffee-house servants, gas, arson) and named the tallies in its report of 8 November 1834. Autopsy's "ruled out" list follows that inquiry. Source: [Burning of Parliament](https://en.wikipedia.org/wiki/Burning_of_Parliament).

The split tally is the Exchequer's: the debtor and the Crown each kept half of a notched hazel stick, and the halves only fit if nobody had cut a notch on one alone. The notch sizes come from Richard FitzNigel's *Dialogus de Scaccario* (c. 1180). Sources:

- [The Exchequer: a chequered history](https://history.blog.gov.uk/2013/08/14/the-exchequer-a-chequered-history/), UK Government History blog
- [Medieval Exchequer tally sticks](https://collection.sciencemuseumgroup.org.uk/objects/co60506/medieval-exchequer-tally-sticks), Science Museum Group

Harrow & Finch Trading and every supplier, customer, account and email in this project are invented.
