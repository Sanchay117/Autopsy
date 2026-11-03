import type {
  Beneficiary,
  Conversion,
  Currency,
  Deposit,
  Transfer,
  TransferMethod,
  TransferStatus,
} from "@/lib/engine/types";

export interface CreateTransfer {
  request_id: string;
  beneficiary: Beneficiary;
  amount: number;
  currency: Currency;
  method: TransferMethod;
  reference: string;
  metadata: Record<string, string>;
}

export interface CreateConversion {
  request_id: string;
  buy_currency: Currency;
  sell_currency: Currency;
  buy_amount: number;
  metadata: Record<string, string>;
}

/**
 * Every call the audit makes to Airwallex goes through this interface, so the
 * sandbox and the offline mock are swapped with one environment variable.
 */
export interface AirwallexRail {
  mode: "sandbox" | "mock";
  createTransfer(req: CreateTransfer): Promise<Transfer>;
  getTransfer(id: string): Promise<Transfer>;
  findTransferByRequestId(requestId: string): Promise<Transfer | undefined>;
  /** Sandbox-only simulation of a status change. */
  transition(id: string, next: TransferStatus, failureType?: string): Promise<Transfer>;
  cancelTransfer(id: string): Promise<Transfer>;
  convert(req: CreateConversion): Promise<Conversion>;
  getConversion(id: string): Promise<Conversion>;
  /** Sandbox-only simulation of an incoming deposit. */
  simulateDeposit(req: { amount: number; currency: Currency; payer_name: string }): Promise<Deposit>;
  getDeposit(id: string): Promise<Deposit>;
}

export class RailError extends Error {
  constructor(
    public code: string,
    message: string,
    public status?: number,
  ) {
    super(`${code}: ${message}`);
  }
}
