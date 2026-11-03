import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import type { Diagnosis, Email, EmailClaims } from "./types";

// The model reads and writes words. It never sees limits, never picks an
// action, and nothing it returns is paid to: a quoted account only counts if
// it matches the vendor master, and code checks that.

const MODEL = "claude-opus-5-5";
const client = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;
export const modelEnabled = () => !!client;

const ClaimsSchema = z.object({
  counterparty: z.string().describe("Company that sent the email, as written in the email"),
  invoiceRefs: z.array(z.string()).describe("Invoice references mentioned, like INV-2044 or AR-7790"),
  claim: z.enum(["payment_not_received", "will_pay_partial_later", "disputes_invoice", "confirms_bank_details", "other"]),
  confirmsBankDetails: z.boolean().describe("Sender states the bank details on file are correct or unchanged"),
  acceptsStablecoin: z.boolean().describe("Sender offers to accept settlement in stablecoin or to a crypto wallet"),
  promisedAmount: z.number().nullable().describe("Amount the sender promises to pay, in major units"),
  promisedDate: z.string().nullable().describe("Date of that promise as YYYY-MM-DD, year 2026 unless stated"),
  quotedAccount: z.string().nullable().describe("IBAN, account number or wallet address quoted, exactly as written"),
  quote: z.string().describe("The single sentence that best supports the claim, copied verbatim, under 30 words"),
});

const ExplainSchema = z.object({
  explanations: z.array(z.object({ breakId: z.string(), text: z.string() })),
});

const claimsCache = new Map<string, EmailClaims>();

/** Structured claims from one email. Claude when a key is set, rules otherwise. */
export async function readEmail(email: Email, known: { invoices: string[]; counterparties: string[] }, useModel = true): Promise<EmailClaims> {
  if (!client || !useModel) return readEmailByRules(email, known);
  const hit = claimsCache.get(email.id);
  if (hit) return hit;
  let out: EmailClaims | null = null;
  try {
    const res = await client.beta.messages.parse({
      model: MODEL,
      max_tokens: 2000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low", format: betaZodOutputFormat(ClaimsSchema) },
      system:
        "You extract what a business email claims, for a finance team's reconciliation. Report only what the email says. Do not infer intent beyond the text. If a field is not stated, use null or false.",
      messages: [
        {
          role: "user",
          content: `Known invoice ids: ${known.invoices.join(", ")}\nKnown counterparties: ${known.counterparties.join(", ")}\n\nFrom: ${email.from}\nSubject: ${email.subject}\n\n${email.body}`,
        },
      ],
    });
    const p = res.stop_reason === "refusal" ? null : res.parsed_output;
    if (p) {
      out = {
        emailId: email.id,
        counterparty: p.counterparty,
        invoiceRefs: p.invoiceRefs.filter((r) => known.invoices.includes(r)),
        claim: p.claim,
        confirmsBankDetails: p.confirmsBankDetails,
        acceptsStablecoin: p.acceptsStablecoin,
        promisedAmount: p.promisedAmount ?? undefined,
        promisedDate: p.promisedDate ?? undefined,
        quotedAccount: p.quotedAccount ?? undefined,
        quote: p.quote,
        extractedBy: "claude",
      };
    }
  } catch (err) {
    console.warn(`[read] Claude extraction failed for ${email.id}, using rules:`, err instanceof Error ? err.message : err);
  }
  out ??= readEmailByRules(email, known);
  claimsCache.set(email.id, out);
  return out;
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/** Deterministic fallback so the demo runs with no API key. */
export function readEmailByRules(email: Email, known: { invoices: string[]; counterparties: string[] }): EmailClaims {
  const text = `${email.subject}\n${email.body}`;
  const sentences = email.body.split(/(?<=[.!?])\s+/).map((s) => s.replace(/\s+/g, " ").trim());
  const find = (re: RegExp) => sentences.find((s) => re.test(s));

  const invoiceRefs = [...new Set(text.match(/\b(?:INV|AR)-\d{4}\b/g) ?? [])].filter((r) => known.invoices.includes(r));
  const counterparty =
    known.counterparties.find((c) => text.toLowerCase().includes(c.toLowerCase())) ??
    known.counterparties.find((c) => email.from.includes(c.split(" ")[0].toLowerCase())) ??
    email.from;

  const notReceived = /(not|never) (yet )?(been )?received|nothing (has )?(arrived|received)/i;
  const partial = /will pay\b.*\b(balance|rest|remainder)\b/i;
  const dispute = /\b(query|dispute|short-shipped|incorrect)\b/i;
  const claim: EmailClaims["claim"] = partial.test(text)
    ? "will_pay_partial_later"
    : notReceived.test(text)
      ? "payment_not_received"
      : dispute.test(text)
        ? "disputes_invoice"
        : /details (have not|haven't) changed/i.test(text)
          ? "confirms_bank_details"
          : "other";

  const promise = text.match(/will pay (USD|EUR|GBP) ?([\d,]+(?:\.\d+)?) on (\d{1,2}) ([A-Za-z]+)/i);
  const month = promise ? MONTHS.indexOf(promise[4].toLowerCase()) : -1;
  const iban = text.match(/\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){4}(?: ?[A-Z0-9]{1,4})?\b/);
  const wallet = text.match(/\b0x[a-fA-F0-9]{40}\b/);

  const quote =
    (claim === "payment_not_received" && find(notReceived)) ||
    (claim === "will_pay_partial_later" && find(/will pay/i)) ||
    (claim === "disputes_invoice" && find(dispute)) ||
    sentences[1] ||
    email.subject;

  return {
    emailId: email.id,
    counterparty,
    invoiceRefs,
    claim,
    confirmsBankDetails: /details (have not|haven't) changed|details are (correct|unchanged)/i.test(text),
    acceptsStablecoin: /\b(metal wallet|stablecoin|usdc|crypto wallet)\b/i.test(text),
    promisedAmount: promise ? Number(promise[2].replace(/,/g, "")) : undefined,
    promisedDate: promise && month >= 0 ? `2026-${String(month + 1).padStart(2, "0")}-${promise[3].padStart(2, "0")}` : undefined,
    quotedAccount: iban?.[0] ?? wallet?.[0],
    quote: quote.length > 160 ? quote.slice(0, 157) + "..." : quote,
    extractedBy: "rules",
  };
}

const explainCache = new Map<string, string>();

/**
 * Rewrite each diagnosis as two plain sentences for an approver. The facts and
 * the cause are fixed before this runs; the model only words them. One call
 * covers every break, and results are cached by the facts they were given.
 */
export async function explain(diagnoses: Diagnosis[], useModel = true): Promise<Diagnosis[]> {
  if (!client || !useModel || diagnoses.length === 0) return diagnoses;
  const key = (d: Diagnosis) => `${d.breakId}|${d.cause}|${d.chain.map((c) => c.fact).join("|")}|${d.counterfactual?.replayed.value ?? ""}`;
  const todo = diagnoses.filter((d) => !explainCache.has(key(d)));
  if (todo.length) {
    try {
      const res = await client.beta.messages.parse({
        model: MODEL,
        max_tokens: 4000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "low", format: betaZodOutputFormat(ExplainSchema) },
        system:
          "You write for a finance approver who has 10 seconds. For each break, write exactly two short sentences: what happened, then why, using the given facts and numbers only. Plain words, no jargon, no hedging, no recommendations, no dashes used as punctuation.",
        messages: [
          {
            role: "user",
            content: JSON.stringify(
              todo.map((d) => ({
                breakId: d.breakId,
                cause: d.causeLabel,
                facts: d.chain.map((c) => c.fact),
                counterfactual: d.counterfactual && {
                  question: d.counterfactual.question,
                  actual: `${d.counterfactual.actual.label}: ${d.counterfactual.actual.value}`,
                  replayed: `${d.counterfactual.replayed.label}: ${d.counterfactual.replayed.value}`,
                },
              })),
            ),
          },
        ],
      });
      const p = res.stop_reason === "refusal" ? null : res.parsed_output;
      for (const e of p?.explanations ?? []) {
        const d = todo.find((x) => x.breakId === e.breakId);
        if (d) explainCache.set(key(d), e.text.replace(/\s*[\u2014\u2013]\s*/g, ", "));
      }
    } catch (err) {
      console.warn("[read] Claude explanation failed, keeping rule text:", err instanceof Error ? err.message : err);
    }
  }
  return diagnoses.map((d) => {
    const text = explainCache.get(key(d));
    return text ? { ...d, explanation: text, explainedBy: "claude" as const } : d;
  });
}
