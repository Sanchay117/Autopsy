import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface MetalPayout {
  outcome: "paid" | "refused" | "pending" | "held";
  transaction?: string;
  spent: string;
  payee: string;
  amount: number;
  paymentId: string;
  explorer?: string;
  detail: string;
}

/**
 * Direct payouts on Metal testnet under a mandate. The mandate holds the payee
 * allowlist and the cap on chain, and --payment-id makes a retry pay at most
 * once, so a replacement sent here cannot become a second payment.
 */
export interface MetalRail {
  mode: "testnet" | "mock" | "off";
  payout(req: { to: string; amount: number; paymentId: string }): Promise<MetalPayout>;
}

export class OffMetal implements MetalRail {
  mode = "off" as const;
  async payout(): Promise<MetalPayout> {
    throw new Error("Metal is not enabled. Set METAL_MODE to mock or testnet.");
  }
}

/** Offline stand-in that keeps the at-most-once rule of mandate pull. */
export class MockMetal implements MetalRail {
  mode = "mock" as const;
  private paid = new Map<string, MetalPayout>();
  private spent = 0;
  constructor(private budget = 10_000) {}

  async payout(req: { to: string; amount: number; paymentId: string }): Promise<MetalPayout> {
    const prior = this.paid.get(req.paymentId);
    if (prior) return { ...prior, detail: "already paid, nothing sent" };
    if (this.spent + req.amount > this.budget) {
      return {
        outcome: "refused",
        spent: `${this.spent} *USDZ of ${this.budget} *USDZ`,
        payee: req.to,
        amount: req.amount,
        paymentId: req.paymentId,
        detail: "mandate budget exceeded",
      };
    }
    this.spent += req.amount;
    const tx = "0x" + createHash("sha256").update(req.paymentId).digest("hex");
    const result: MetalPayout = {
      outcome: "paid",
      transaction: tx,
      spent: `${this.spent} *USDZ of ${this.budget} *USDZ`,
      payee: req.to,
      amount: req.amount,
      paymentId: req.paymentId,
      detail: "mock: no chain call made",
    };
    this.paid.set(req.paymentId, result);
    return result;
  }
}

/** Calls the metal-agent CLI. Needs METAL_CREDENTIAL and METAL_RPC_URL. */
export class TestnetMetal implements MetalRail {
  mode = "testnet" as const;
  constructor(
    private credential: string,
    private rpcUrl: string,
  ) {}

  async payout(req: { to: string; amount: number; paymentId: string }): Promise<MetalPayout> {
    const args = [
      "mandate", "pull",
      "--credential", this.credential,
      "--to", req.to,
      "--amount", req.amount.toFixed(2),
      "--payment-id", req.paymentId,
      "--network", "testnet",
      "--rpc-url", this.rpcUrl,
    ];
    let stdout = "";
    let code = 0;
    try {
      ({ stdout } = await run("metal-agent", args, { timeout: 120_000 }));
    } catch (e) {
      const err = e as { code?: number; stdout?: string; stderr?: string };
      code = err.code ?? 1;
      stdout = `${err.stdout ?? ""}\n${err.stderr ?? ""}`;
    }
    const field = (name: string) => stdout.match(new RegExp(`^${name}\\s+(.+)$`, "m"))?.[1]?.trim();
    // Exit codes from the payout docs: 0 paid, 1 refused, 3 pending, 4 held.
    const outcome = (field("outcome") ?? { 0: "paid", 1: "refused", 3: "pending", 4: "held" }[code] ?? "refused") as MetalPayout["outcome"];
    return {
      outcome,
      transaction: field("transaction"),
      spent: field("spent") ?? "",
      payee: field("payee") ?? req.to,
      amount: req.amount,
      paymentId: req.paymentId,
      explorer: field("explorer"),
      detail: stdout.trim().split("\n").slice(-1)[0] ?? "",
    };
  }
}
