// Shared vocabulary for the audit. Books are the company's half of the tally,
// movements are Airwallex's half, and a break is a notch that does not fit.

export type Currency = "USD" | "EUR" | "GBP";
export type TransferMethod = "LOCAL" | "SWIFT";

export type TransferStatus =
  | "PROCESSING"
  | "SENT"
  | "PAID"
  | "FAILED"
  | "CANCELLED";

/** The subset of an Airwallex transfer the audit reads. */
export interface Transfer {
  id: string;
  request_id: string;
  short_reference_id: string;
  beneficiary_id: string;
  transfer_amount: number;
  transfer_currency: Currency;
  transfer_method: TransferMethod;
  fee_amount: number;
  fee_currency: Currency;
  reference: string;
  status: TransferStatus;
  failure_type?: string;
  failure_reason?: string;
  /** Statuses seen, oldest first. Only the audit's own reads fill this. */
  history: { status: TransferStatus; at: string }[];
  metadata: Record<string, string>;
  created_at: string;
}

export interface Conversion {
  id: string;
  request_id: string;
  buy_currency: Currency;
  sell_currency: Currency;
  buy_amount: number;
  sell_amount: number;
  client_rate: number;
  status: "SETTLED";
  created_at: string;
  metadata: Record<string, string>;
}

export interface Deposit {
  id: string;
  amount: number;
  currency: Currency;
  payer_name: string;
  reference: string;
  created_at: string;
}

export interface Beneficiary {
  id: string;
  name: string;
  country: string;
  currency: Currency;
  method: TransferMethod;
  /** Masked account detail, shown to approvers. */
  account: string;
}

/** One signed change to a pocket balance, derived from Airwallex objects. */
export interface Movement {
  id: string;
  at: string;
  currency: Currency;
  amount: number;
  kind:
    | "DEPOSIT"
    | "CONVERSION_SELL"
    | "CONVERSION_BUY"
    | "PAYOUT"
    | "PAYOUT_FEE"
    | "PAYOUT_REFUND";
  sourceId: string;
  ref: string;
}

// ---------- The books ----------

export type EntryKind = "payable" | "receivable" | "fx_plan";

export interface BookEntry {
  id: string;
  kind: EntryKind;
  counterparty: string;
  currency: Currency;
  amount: number;
  due: string;
  /** What the books believe happened. */
  booked: "paid" | "open" | "expected" | "converted";
  method?: TransferMethod;
  beneficiaryId?: string;
  /** For fx_plan entries: the rate the treasury plan assumed. */
  plannedRate?: number;
  sellCurrency?: Currency;
  memo: string;
}

export interface Pocket {
  currency: Currency;
  opening: number;
  reserveFloor: number;
}

// ---------- Evidence ----------

export type EvidenceSource = "airwallex" | "books" | "email" | "metal" | "policy";

export interface Evidence {
  id: string;
  source: EvidenceSource;
  /** How much this kind of evidence is trusted, 0 to 1. Set in code. */
  weight: number;
  summary: string;
  at: string;
  /** Objects this evidence touches, for revising only affected decisions. */
  touches: string[];
  raw?: unknown;
}

export interface Email {
  id: string;
  from: string;
  subject: string;
  body: string;
  receivedAt: string;
}

/** What the model may say about an email. Code decides what it means. */
export interface EmailClaims {
  emailId: string;
  counterparty: string;
  invoiceRefs: string[];
  claim:
    | "payment_not_received"
    | "will_pay_partial_later"
    | "disputes_invoice"
    | "confirms_bank_details"
    | "other";
  confirmsBankDetails: boolean;
  /** The counterparty offered to take stablecoin settlement. */
  acceptsStablecoin: boolean;
  promisedAmount?: number;
  promisedDate?: string;
  /** A payment address or IBAN quoted in the email. Never paid to directly. */
  quotedAccount?: string;
  quote: string;
  extractedBy: "claude" | "rules";
}

// ---------- Breaks, causes, decisions ----------

export type BreakKind =
  | "RETURNED_AFTER_BOOKED_PAID"
  | "FEE_NOT_FUNDED"
  | "IN_FLIGHT_DISPUTED"
  | "DUPLICATE_PAYMENT"
  | "RECEIPT_MISSING"
  | "RECEIPT_SHORT"
  | "FX_RATE_VARIANCE";

export interface Break {
  id: string;
  kind: BreakKind;
  title: string;
  entryIds: string[];
  currency: Currency;
  /** Bank minus books, in the break's currency. */
  variance: number;
  varianceUsd: number;
  /** Money at stake even when the balances agree, such as an unpaid supplier. */
  exposureUsd: number;
  objectIds: string[];
  evidenceIds: string[];
}

export type CauseCode =
  | "BANK_RETURN_ACCOUNT_CLOSED"
  | "BANK_RETURN"
  | "SWIFT_FEE_NOT_IN_FUNDING"
  | "PAYOUT_FEE_NOT_BOOKED"
  | "STILL_IN_FLIGHT"
  | "MANUAL_RESUBMISSION"
  | "CUSTOMER_LATE"
  | "PAYER_BANK_CHARGE"
  | "PARTIAL_PAYMENT"
  | "RATE_MOVED_SINCE_PLAN";

export interface Counterfactual {
  question: string;
  intervention: string;
  actual: { label: string; value: string };
  replayed: { label: string; value: string };
  wouldHaveCleared: boolean;
}

export interface Diagnosis {
  breakId: string;
  cause: CauseCode;
  causeLabel: string;
  /** Chain of facts from symptom to cause, each tied to evidence. */
  chain: { fact: string; evidenceId: string }[];
  /** Explanations a person would reach for first, each ruled out by a fact the data shows. */
  ruledOut: { theory: string; why: string; evidenceId: string }[];
  confidence: number;
  counterfactual?: Counterfactual;
  /** Plain explanation for a person. Written by the model when available. */
  explanation: string;
  explainedBy: "claude" | "rules";
}

export type ActionKind =
  | "WAIT"
  | "REPLACE"
  | "TOP_UP"
  | "CANCEL_DUPLICATE"
  | "POST_ADJUSTMENT"
  | "CHASE"
  | "DEFER"
  | "PAY"
  | "CONVERT"
  | "REQUEST_DETAILS"
  | "ESCALATE";

export type Rail = "airwallex" | "metal" | "books";

export interface ActionOption {
  kind: ActionKind;
  rail: Rail;
  label: string;
  amount: number;
  currency: Currency;
  amountUsd: number;
  counterparty: string;
  /** Expected cost of choosing this option, in USD. */
  expectedCostUsd: number;
  /** Chance this option leaves money wrong, 0 to 1. */
  risk: number;
  etaHours: number;
  blockedBy?: string;
}

export interface Decision {
  id: string;
  breakId: string;
  chosen: ActionOption;
  rejected: (ActionOption & { why: string })[];
  autonomyLimitUsd: number;
  needsApproval: boolean;
  approvalReason?: string;
  /** Set when a person signed these exact terms and the action ran on that signature. */
  approved?: boolean;
  /** Hash of the exact terms an approver sees. Execution re-checks it. */
  binding: string;
  bindingTerms: Record<string, string | number>;
  dependsOn: string[];
  /** Confidence the autonomy limit was set from: the diagnosis, or a forecast. */
  confidence: number;
  /** For actions timed to a date, such as funding next week's batch. */
  executeOn?: string;
  status: "proposed" | "scheduled" | "awaiting_approval" | "executed" | "refused" | "superseded";
  result?: string;
  revision: number;
}

export interface Rule {
  id: string;
  learnedFrom: string;
  text: string;
  appliesTo: string;
}

export interface TraceStep {
  at: string;
  stage: "seed" | "detect" | "diagnose" | "decide" | "act" | "learn" | "evidence" | "revise";
  text: string;
  ref?: string;
}

export interface DecisionDiff {
  evidenceId: string;
  evidenceLabel: string;
  changes: {
    breakId: string;
    before: { action: string; approval: boolean; confidence: number };
    after: { action: string; approval: boolean; confidence: number };
  }[];
  untouched: string[];
}
