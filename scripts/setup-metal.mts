// Prepares Metal testnet for settling a returned invoice, once:
//   1. creates a Metal account owned by a key in .autopsy/metal/owner-key.json (the faucet funds its gas),
//   2. funds the account with *USDZ from the testnet faucet,
//   3. writes a mandate that may pay only Brennholz's wallet from the vendor master, and binds it,
//   4. leaves the credential at .autopsy/metal/mandate.json, which the app reads when METAL_MODE=testnet.
//
//   METAL_RPC_URL=... pnpm setup:metal
//
// Needs the metal-agent CLI on PATH: npm install -g @metalntwx/metal-agent@0.3.3
// Running it again reuses the account and the mandate already in .autopsy/metal.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { VENDORS } from "@/lib/engine/scenario";

const run = promisify(execFile);

const { METAL_RPC_URL } = process.env;
if (!METAL_RPC_URL) {
  console.error("METAL_RPC_URL is empty in .env.local. Create an endpoint in the Metal console, https://console-testnet.metalntwx.com, signed in with the email you registered with.");
  process.exit(1);
}

// The faucet grants 100 *USDZ at a time, so the app scales settlements down (METAL_SCALE, 0.001 by
// default: USD 4,516 goes out as 4.52 *USDZ). The cap stops an unscaled amount from ever paying.
const CAP = 10;
const BUDGET = 90;

const dir = path.join(process.cwd(), ".autopsy", "metal");
const file = (name: string) => path.join(dir, name);
const net = ["--network", "testnet"];
const rpc = ["--rpc-url", METAL_RPC_URL];
const brn = VENDORS.find((v) => v.id === "V-BRN")!;

interface State {
  account?: string;
  owner?: string;
  bound?: boolean;
}
const stateFile = file("account.json");
const state: State = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : {};
const save = () => writeFileSync(stateFile, JSON.stringify(state, null, 2));

/** Run metal-agent, echo what it prints (it never prints a key), and read its `name value` lines. */
async function agent(args: string[]) {
  let stdout = "";
  try {
    ({ stdout } = await run("metal-agent", args, { timeout: 180_000 }));
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message: string };
    throw new Error(`metal-agent ${args.slice(0, 2).join(" ")}: ${(err.stderr || err.stdout || err.message).trim()}`);
  }
  for (const l of stdout.trim().split("\n")) console.log(`   ${l}`);
  return (name: string) => stdout.match(new RegExp(`^${name}\\s+(\\S+)`, "m"))?.[1];
}

console.log("Metal testnet setup\n");
mkdirSync(dir, { recursive: true });
try {
  if (!state.account) {
    console.log("1. Creating the Metal account");
    const f = await agent(["account", "create", "--out", file("owner-key.json"), ...net, ...rpc]);
    state.account = f("account");
    state.owner = f("owner");
    if (!state.account) throw new Error("account create printed no account address");
    save();
    // The faucet grants one client once a minute, and account create just used it for gas.
    console.log("   waiting a minute for the faucet");
    await new Promise((r) => setTimeout(r, 61_000));
  } else {
    console.log(`1. Reusing account ${state.account}`);
  }

  console.log("2. Funding the account");
  await agent(["fund", state.account, ...net]);

  if (!existsSync(file("mandate.json"))) {
    console.log(`3. Writing the mandate: pays only ${brn.name}, at most ${CAP} *USDZ a payment, ${BUDGET} *USDZ in all`);
    await agent([
      "mandate", "credential", "create",
      "--principal", state.account,
      "--payee", `${brn.metalAddress},${brn.name}`,
      "--cap", String(CAP),
      "--budget", String(BUDGET),
      "--description", "Autopsy: settle returned Brennholz invoices on Metal",
      "--key", file("owner-key.json"),
      "--out", file("mandate.json"),
      ...net,
    ]);
  } else {
    console.log("3. Reusing the mandate in .autopsy/metal/mandate.json");
  }

  if (!state.bound) {
    console.log("4. Binding it to the account");
    await agent(["mandate", "bind", "--credential", file("mandate.json"), "--key", file("owner-key.json"), ...net, ...rpc]);
    state.bound = true;
    save();
  } else {
    console.log("4. Already bound");
  }

  console.log("\nThe mandate now:");
  await agent(["mandate", "status", "--credential", file("mandate.json"), ...net, ...rpc]);
} catch (err) {
  console.error(`\nStopped: ${(err as Error).message}`);
  console.error("Progress is saved in .autopsy/metal. Run this again once the cause is fixed.");
  process.exit(1);
}
console.log("\nDone. Set METAL_MODE=testnet in .env.local and restart the app.");
