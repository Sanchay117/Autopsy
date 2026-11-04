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
  /** *USDZ actually sent, when testnet settles a scaled-down amount. */
  onChain?: number;
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

/** Calls the metal-agent CLI with a mandate credential and the user's RPC endpoint. */
export class TestnetMetal implements MetalRail {
  mode = "testnet" as const;
  constructor(
    private credential: string,
    private rpcUrl: string,
    /** *USDZ sent per USD settled. The testnet faucet grants 100 *USDZ at a time, so real invoice amounts do not fit. */
    private scale = 1,
  ) {}

  async payout(req: { to: string; amount: number; paymentId: string }): Promise<MetalPayout> {
    const onChain = Math.max(0.01, Math.round(req.amount * this.scale * 100) / 100);
    const args = [
      "mandate", "pull",
      "--credential", this.credential,
      "--to", req.to,
      "--amount", onChain.toFixed(2),
      "--payment-id", req.paymentId,
      "--network", "testnet",
      "--rpc-url", this.rpcUrl,
    ];
    // A pending pull has no outcome yet. The same command, with the same id, payee and amount, sends
    // the same pull, which pays at most once: run it again a few times before reporting pending.
    let stdout = "";
    let outcome: MetalPayout["outcome"] = "pending";
    for (let attempt = 0; outcome === "pending" && attempt < 5; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 3_000));
      let code = 0;
      try {
        ({ stdout } = await run("metal-agent", args, { timeout: 120_000 }));
      } catch (e) {
        const err = e as { code?: number; stdout?: string; stderr?: string };
        code = err.code ?? 1;
        stdout = `${err.stdout ?? ""}\n${err.stderr ?? ""}`;
      }
      outcome = outcomeOf(stdout, code);
    }
    const field = (name: string) => stdout.match(new RegExp(`^${name}\\s+(.+)$`, "m"))?.[1]?.trim();
    return {
      outcome,
      transaction: field("transaction"),
      spent: field("spent") ?? "",
      payee: field("payee") ?? req.to,
      amount: req.amount,
      onChain: onChain === req.amount ? undefined : onChain,
      paymentId: req.paymentId,
      explorer: field("explorer"),
      // A paid pull's last line is its gas; the mandate's spend says more. Anything else ends with the reason.
      detail: outcome === "paid" && field("spent") ? `mandate spent ${field("spent")}` : (stdout.trim().split("\n").slice(-1)[0] ?? ""),
    };
  }
}

/**
 * What a `mandate pull` came to. The outcome line can carry a note ("refused, not sent"), a retry of
 * a paid pull reports "already paid, nothing sent", and an error saying the pull may have been sent
 * has no outcome yet. Exit codes from the payout docs: 0 paid, 1 refused, 3 pending, 4 held.
 */
function outcomeOf(stdout: string, code: number): MetalPayout["outcome"] {
  if (/already paid, nothing sent/i.test(stdout)) return "paid";
  if (/may have been sent|payment in doubt|can land until/i.test(stdout)) return "pending";
  const word = stdout.match(/^outcome\s+(\w+)/m)?.[1];
  if (word === "paid" || word === "refused" || word === "pending" || word === "held") return word;
  return ({ 0: "paid", 1: "refused", 3: "pending", 4: "held" } as Record<number, MetalPayout["outcome"]>)[code] ?? "refused";
}
