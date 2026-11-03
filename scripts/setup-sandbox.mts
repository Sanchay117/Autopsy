// Prepares an Airwallex sandbox account for the audit, once:
//   1. finds a USD Global Account (or opens one) for simulated deposits,
//   2. creates one beneficiary per supplier in the vendor master,
//   3. writes their ids to .autopsy/sandbox.json, which the app reads when AWX_MODE=sandbox.
//
//   AWX_CLIENT_ID=... AWX_API_KEY=... pnpm setup:sandbox
//
// Running it again reuses what is already in .autopsy/sandbox.json.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { VENDORS, type Vendor } from "@/lib/engine/scenario";
import { SandboxAirwallex } from "@/lib/rails/airwallex/sandbox";

const { AWX_CLIENT_ID, AWX_API_KEY } = process.env;
if (!AWX_CLIENT_ID || !AWX_API_KEY) {
  const missing = [!AWX_CLIENT_ID && "AWX_CLIENT_ID", !AWX_API_KEY && "AWX_API_KEY"].filter(Boolean).join(" and ");
  console.error(`${missing} is empty in .env.local. Both come from the sandbox web app, https://www.sandbox.airwallex.com/app/ (Account > Developer > API keys).`);
  process.exit(1);
}

const dir = path.join(process.cwd(), ".autopsy");
const file = path.join(dir, "sandbox.json");
const saved = existsSync(file)
  ? (JSON.parse(readFileSync(file, "utf8")) as { usdGlobalAccountId?: string; beneficiaries?: Record<string, string> })
  : {};

const api = new SandboxAirwallex(AWX_CLIENT_ID, AWX_API_KEY, "");
type Json = Record<string, unknown>;

// ---------- IBAN check digits (ISO 13616, mod 97) ----------

const mod97 = (s: string) => [...s].reduce((r, ch) => (r * 10 + Number(ch)) % 97, 0);
const digits = (s: string) => [...s].map((c) => (/[A-Z]/.test(c) ? String(c.charCodeAt(0) - 55) : c)).join("");
const ibanValid = (iban: string) => mod97(digits(iban.slice(4) + iban.slice(0, 4))) === 1;

// ---------- Bank details the sandbox will accept ----------

// Real routing codes with invented account numbers. The vendor master keeps
// these masked for display; the sandbox needs them whole.
const ADDRESS: Record<string, Json> = {
  DE: { street_address: "Holzmarkt 12", city: "Köln", postcode: "50676", country_code: "DE" },
  GB: { street_address: "4 Quay Street", city: "Bristol", postcode: "BS1 4DB", country_code: "GB" },
  US: { street_address: "220 Harbor Way", city: "Newark", state: "NJ", postcode: "07114", country_code: "US" },
};

function bankDetails(v: Vendor): Json {
  const base = { account_currency: v.currency, account_name: v.name, bank_country_code: v.country };
  if (v.country === "DE") {
    const iban = v.account.replace(/\s/g, "");
    if (!ibanValid(iban)) throw new Error(`${v.id}: ${v.account} fails the IBAN check`);
    // Bank code 37040044 is Commerzbank Köln.
    return { ...base, iban, swift_code: "COBADEFFXXX" };
  }
  if (v.country === "GB") {
    const [sort, account] = v.account.split(" ");
    return {
      ...base,
      account_number: account,
      account_routing_type1: "sort_code",
      account_routing_value1: sort.replace(/-/g, ""),
      local_clearing_system: "FASTER_PAYMENTS",
    };
  }
  // "ABA 021000021 ••••1121": keep the routing number and the last four, pad the rest.
  const [, aba, masked] = v.account.split(" ");
  return {
    ...base,
    account_number: `0000${aba.slice(-4)}${masked.slice(-4)}`,
    account_routing_type1: "aba",
    account_routing_value1: aba,
    // Required for US ACH; suppliers are paid into business checking accounts.
    bank_account_category: "Checking",
    local_clearing_system: "ACH",
  };
}

// ---------- 1. USD Global Account ----------

async function usdGlobalAccount(): Promise<string> {
  if (saved.usdGlobalAccountId) return saved.usdGlobalAccountId;
  const page = await api.call<{ items?: Json[] }>("GET", "/api/v1/global_accounts?required_features.currency=USD&page_size=50");
  const open = page.items?.find((a) => a.status === "ACTIVE" || a.status === "OPEN");
  if (open) {
    console.log(`  using Global Account ${open.id} (${open.nick_name ?? "USD"})`);
    return String(open.id);
  }
  const made = await api.call<Json>("POST", "/api/v1/global_accounts/create", {
    request_id: `autopsy-ga-usd-${Date.now()}`,
    country_code: "US",
    nick_name: "Autopsy audit USD",
    required_features: [{ currency: "USD", transfer_method: "LOCAL" }],
  });
  console.log(`  opened Global Account ${made.id}, status ${made.status}`);
  return String(made.id);
}

// ---------- 2. Beneficiaries ----------

async function beneficiary(v: Vendor): Promise<string> {
  const known = saved.beneficiaries?.[v.id];
  if (known) return known;
  const made = await api.call<Json>("POST", "/api/v1/beneficiaries/create", {
    nickname: `${v.id} ${v.name}`,
    transfer_methods: [v.method],
    beneficiary: {
      entity_type: "COMPANY",
      type: "BANK_ACCOUNT",
      company_name: v.name,
      address: ADDRESS[v.country],
      bank_details: bankDetails(v),
    },
  });
  console.log(`  ${v.id} ${v.name}: ${made.id}`);
  return String(made.id);
}

console.log("Airwallex sandbox setup");
const out = { usdGlobalAccountId: "", beneficiaries: { ...(saved.beneficiaries ?? {}) } };
try {
  out.usdGlobalAccountId = await usdGlobalAccount();
  for (const v of VENDORS) {
    try {
      out.beneficiaries[v.id] = await beneficiary(v);
    } catch (err) {
      throw new Error(`${v.id} ${v.name}: ${(err as Error).message}`);
    }
  }
} catch (err) {
  // Keep whatever was created, so a second run picks up where this one stopped.
  if (out.usdGlobalAccountId || Object.keys(out.beneficiaries).length) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify(out, null, 2));
  }
  console.error(`\nStopped: ${(err as Error).message}`);
  console.error("Partial progress saved. Fix the field the sandbox named and run this again.");
  process.exit(1);
}
mkdirSync(dir, { recursive: true });
writeFileSync(file, JSON.stringify(out, null, 2));
console.log(`\nWrote ${path.relative(process.cwd(), file)}. Start the app with AWX_MODE=sandbox.`);
