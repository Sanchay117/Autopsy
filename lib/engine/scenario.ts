import type { BookEntry, Currency, Email, Pocket, TransferMethod } from "./types";

// Synthetic books for a made-up company. Every name, account and invoice here
// is invented for the demo. Bank details use valid routing codes with made-up
// account numbers, as the sandbox requires.

export const COMPANY = "Harrow & Finch Trading";
export const AUDIT_DATE = "2026-11-03";

export interface Vendor {
  id: string;
  name: string;
  country: string;
  currency: Currency;
  method: TransferMethod;
  account: string;
  /** Metal testnet address registered at onboarding, if the vendor has one. */
  metalAddress?: string;
  email: string;
}

export const VENDORS: Vendor[] = [
  {
    id: "V-BRN",
    name: "Brennholz Holzbau GmbH",
    country: "DE",
    currency: "EUR",
    method: "SWIFT",
    account: "DE89 3704 0044 0532 0130 00",
    metalAddress: "0x4b7e0c1f9a2d33e1c5a8f0b6d2e7a91c3f05d8b2",
    email: "ap@brennholz-holzbau.example",
  },
  {
    id: "V-SAU",
    name: "Sauer Feinmechanik GmbH",
    country: "DE",
    currency: "EUR",
    method: "SWIFT",
    account: "DE62 3704 0044 0532 0130 01",
    email: "buchhaltung@sauer-feinmechanik.example",
  },
  {
    id: "V-HBR",
    name: "Harbour Print Ltd",
    country: "GB",
    currency: "GBP",
    method: "LOCAL",
    account: "20-00-00 55779911",
    email: "accounts@harbourprint.example",
  },
  {
    id: "V-KES",
    name: "Kestrel Freight Inc",
    country: "US",
    currency: "USD",
    method: "LOCAL",
    account: "ABA 021000021 ••••1121",
    email: "billing@kestrelfreight.example",
  },
  {
    id: "V-IRN",
    name: "Ironvale Packaging LLC",
    country: "US",
    currency: "USD",
    method: "LOCAL",
    account: "ABA 026009593 ••••4410",
    email: "ar@ironvale.example",
  },
];

export const vendorByName = (name: string) => VENDORS.find((v) => v.name === name);

export const POCKETS: Pocket[] = [
  { currency: "USD", opening: 30_000, reserveFloor: 5_000 },
  { currency: "EUR", opening: 0, reserveFloor: 0 },
  { currency: "GBP", opening: 0, reserveFloor: 0 },
];

/** The treasury plan's rate for the EUR batch, a week older than the booking. */
export const PLANNED_EURUSD = 0.915;

export function initialBooks(gbpBookedRate: number): BookEntry[] {
  return [
    {
      id: "FXP-118",
      kind: "fx_plan",
      counterparty: "Treasury plan",
      currency: "EUR",
      amount: 6_000,
      sellCurrency: "USD",
      plannedRate: PLANNED_EURUSD,
      due: "2026-10-26",
      booked: "converted",
      memo: "Fund EUR batch: INV-2041 + INV-2044",
    },
    {
      id: "FXP-119",
      kind: "fx_plan",
      counterparty: "Treasury plan",
      currency: "GBP",
      amount: 3_200,
      sellCurrency: "USD",
      plannedRate: gbpBookedRate,
      due: "2026-10-23",
      booked: "converted",
      memo: "Fund GBP payout: INV-2039",
    },
    {
      id: "INV-2039",
      kind: "payable",
      counterparty: "Harbour Print Ltd",
      currency: "GBP",
      amount: 3_200,
      method: "LOCAL",
      due: "2026-10-24",
      booked: "paid",
      memo: "Catalogue print run, October",
    },
    {
      id: "INV-2041",
      kind: "payable",
      counterparty: "Sauer Feinmechanik GmbH",
      currency: "EUR",
      amount: 2_000,
      method: "SWIFT",
      due: "2026-10-27",
      booked: "paid",
      memo: "Calibration tooling",
    },
    {
      id: "INV-2044",
      kind: "payable",
      counterparty: "Brennholz Holzbau GmbH",
      currency: "EUR",
      amount: 4_000,
      method: "SWIFT",
      due: "2026-10-31",
      booked: "paid",
      memo: "Oak shelving, lot 7",
    },
    {
      id: "INV-2047",
      kind: "payable",
      counterparty: "Kestrel Freight Inc",
      currency: "USD",
      amount: 7_250,
      method: "LOCAL",
      due: "2026-10-31",
      booked: "paid",
      memo: "October freight, 14 consignments",
    },
    {
      id: "INV-2050",
      kind: "payable",
      counterparty: "Ironvale Packaging LLC",
      currency: "USD",
      amount: 9_800,
      method: "LOCAL",
      due: "2026-11-06",
      booked: "open",
      memo: "Corrugated cartons, Q4 order",
    },
    {
      id: "AR-7781",
      kind: "receivable",
      counterparty: "Alder Street Outfitters",
      currency: "USD",
      amount: 18_000,
      due: "2026-10-30",
      booked: "expected",
      memo: "Wholesale order 7781",
    },
    {
      id: "AR-7790",
      kind: "receivable",
      counterparty: "Copperline Clinics",
      currency: "USD",
      amount: 12_000,
      due: "2026-11-07",
      booked: "expected",
      memo: "Supplies contract, November",
    },
    {
      id: "INV-2055",
      kind: "payable",
      counterparty: "Brennholz Holzbau GmbH",
      currency: "EUR",
      amount: 3_000,
      method: "SWIFT",
      due: "2026-11-12",
      booked: "open",
      memo: "Oak shelving, lot 8",
    },
    {
      id: "INV-2056",
      kind: "payable",
      counterparty: "Sauer Feinmechanik GmbH",
      currency: "EUR",
      amount: 2_500,
      method: "SWIFT",
      due: "2026-11-12",
      booked: "open",
      memo: "Spindle bearings",
    },
  ];
}

/** Scenario dates for objects the sandbox stamps with the real clock. */
export const SENT_ON: Record<string, string> = {
  "INV-2039": "2026-10-24",
  "INV-2041": "2026-10-27",
  "INV-2044": "2026-10-28",
  "INV-2047": "2026-10-31",
};

export const INBOX: Email[] = [
  {
    id: "EM-311",
    from: "ap@brennholz-holzbau.example",
    subject: "INV-2044: nothing received, deadline passed",
    receivedAt: "2026-11-02T08:14:00Z",
    body: `Hello,

we still have not received payment for invoice INV-2044 (EUR 4.000,00). Our deadline was 31 October and the timber for lot 8 is on hold until this is settled.

Please check the transfer. Our bank details have not changed: IBAN DE89 3704 0044 0532 0130 00, Commerzbank.

If it is faster for you, we can also take settlement to the Metal wallet we registered with you at onboarding.

Regards,
Katrin Vogel
Brennholz Holzbau GmbH, Buchhaltung`,
  },
];

/** Evidence that arrives during the demo, in the order the presenter uses it. */
export const LATE_EMAIL: Email = {
  id: "EM-317",
  from: "accounts@copperline-clinics.example",
  subject: "Re: AR-7790 payment timing",
  receivedAt: "2026-11-03T15:40:00Z",
  body: `Hi team,

before we release payment on invoice AR-7790 we need to query two line items (the glove cartons were short-shipped). We will pay USD 6,000 on 20 November and the balance once the credit note is sorted.

Thanks,
Dev Malhotra
Copperline Clinics, Accounts Payable`,
};

export const ALDER_DEPOSIT = { amount: 17_975, payer_name: "ALDER STREET OUTFITTERS AR-7781" };
