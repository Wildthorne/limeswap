// Timelock operations for LimeSwap governance. Builds *unsigned* transactions (simulated and
// assembled) and prints the base64 XDR on stdout; signing and sending stay in the stellar CLI,
// so no secret key ever passes through this script. Use it through ./gov-op.sh, which pipes
// the XDR into `stellar tx sign` (2 of the 3 multisig keys) and `stellar tx send`.
//
// Why a Node helper: the timelock's `schedule` / `execute` take the target call's arguments as
// `Vec<Val>`, an untyped list. The CLI can't know that an argument is an Address or BytesN<32>
// rather than a string, so it can't encode them reliably. Here the target contract's own spec
// (downloaded from the network) types every argument exactly.
//
// Usage (args = the target function's arguments as a JSON object, by name; bytes as "0x<hex>",
// big integers as strings, enums in SDK form {"tag":"Asset","values":[...]}):
//   node gov-op.mjs <net> schedule <target> <fn> '<args>' --salt 0x… [--delay N] [--source G…]
//   node gov-op.mjs <net> execute  <target> <fn> '<args>' --salt 0x… [--source G…]
//   node gov-op.mjs <net> id       <target> <fn> '<args>' --salt 0x…     → operation id (hex)
//   node gov-op.mjs <net> state    <op-id-hex>                           → Unset|Waiting|Ready|Done + ready ledger
// <target> / --source may be CLI aliases (limeswap-factory, limefx-eur-usd, lime-gov, …).
// Defaults: timelock = alias limeswap-timelock, schedule source = lime-gov (the multisig),
// execute source = lime-owner (execution is open: anyone may run a ready operation).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(new URL("../lime-scripts/package.json", import.meta.url));
const { rpc, contract, Contract, Address, TransactionBuilder, xdr, nativeToScVal, scValToNative, BASE_FEE } =
  require("@stellar/stellar-sdk");

const HERE = new URL(".", import.meta.url).pathname;
const [NET, CMD, ...rest] = process.argv.slice(2);
if (!NET || !CMD) {
  console.error(fs.readFileSync(new URL(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//")).join("\n"));
  process.exit(1);
}
const flag = (name, dflt) => {
  const i = rest.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const v = rest[i + 1];
  rest.splice(i, 2);
  return v;
};
const cfg = JSON.parse(fs.readFileSync(`${HERE}../deployed.${NET}.json`, "utf8"));
const server = new rpc.Server(cfg.rpcUrl, { allowHttp: NET !== "testnet" });
const PASSPHRASE = cfg.passphrase;

const cli = (...a) => execFileSync("stellar", a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
/** CLI alias / identity → address (C… or G…); addresses pass through. */
function resolve(x) {
  if (/^[CG][A-Z2-7]{55}$/.test(x)) return x;
  try {
    return cli("contract", "alias", "show", x, "--network", NET);
  } catch {
    return cli("keys", "address", x);
  }
}
const hex32 = (h) => {
  const b = Buffer.from(h.replace(/^0x/, ""), "hex");
  if (b.length !== 32) throw new Error(`expected 32 bytes of hex, got ${b.length}`);
  return b;
};
const bytesN = (h) => xdr.ScVal.scvBytes(hex32(h));
const ZERO = "0x" + "00".repeat(32);
/** JSON → values the SDK spec understands: "0x…" strings become bytes. */
const prep = (v) =>
  typeof v === "string" && /^0x([0-9a-f]{2})*$/i.test(v)
    ? Uint8Array.from(Buffer.from(v.slice(2), "hex"))
    : Array.isArray(v)
      ? v.map(prep)
      : v && typeof v === "object"
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, prep(x)]))
        : v;

const TIMELOCK = resolve(process.env.TIMELOCK || "limeswap-timelock");

/** Target call → (target address, function symbol, Vec<Val> of typed args). */
async function targetCall(target, fn, argsJson) {
  const id = resolve(target);
  const client = await contract.Client.from({ contractId: id, networkPassphrase: PASSPHRASE, rpcUrl: cfg.rpcUrl, allowHttp: NET !== "testnet" });
  const args = client.spec.funcArgsToScVals(fn, prep(JSON.parse(argsJson || "{}")));
  return [new Address(id).toScVal(), xdr.ScVal.scvSymbol(fn), xdr.ScVal.scvVec(args)];
}

async function build(source, method, ...args) {
  const account = await server.getAccount(source);
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
    .addOperation(new Contract(TIMELOCK).call(method, ...args))
    .setTimeout(600)
    .build();
  return server.prepareTransaction(tx); // simulate + attach footprint, resources and auth
}

async function view(method, ...args) {
  const account = await server.getAccount(resolve(process.env.VIEW_SOURCE || "lime-owner"));
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: PASSPHRASE })
    .addOperation(new Contract(TIMELOCK).call(method, ...args))
    .setTimeout(60)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(sim.error);
  return sim.result.retval;
}

const hexOf = (scv) => Buffer.from(scValToNative(scv)).toString("hex");

if (CMD === "schedule" || CMD === "execute" || CMD === "id") {
  const [target, fn, argsJson] = rest;
  const salt = flag("salt");
  if (!salt) throw new Error("--salt 0x<64 hex> is required (use a fresh random one per operation)");
  const delay = Number(flag("delay", process.env.DELAY || "0"));
  const call = await targetCall(target, fn, argsJson);
  const pred = bytesN(flag("predecessor", ZERO));
  const id = hexOf(await view("hash_operation", ...call, pred, bytesN(salt)));
  if (CMD === "id") {
    console.log(id);
  } else if (CMD === "schedule") {
    const source = resolve(flag("source", "lime-gov"));
    const d = delay || Number(scValToNative(await view("get_min_delay")));
    const tx = await build(source, "schedule", ...call, pred, bytesN(salt), nativeToScVal(d, { type: "u32" }), new Address(source).toScVal());
    console.error(`schedule ${fn} on ${resolve(target)}  op ${id}  delay ${d} ledgers  proposer ${source}`);
    console.log(tx.toXDR());
  } else {
    const source = resolve(flag("source", "lime-owner"));
    const tx = await build(source, "execute", ...call, pred, bytesN(salt), xdr.ScVal.scvVoid());
    console.error(`execute ${fn} on ${resolve(target)}  op ${id}`);
    console.log(tx.toXDR());
  }
} else if (CMD === "cancel") {
  // Cancelling is a veto: since review M1 only the proposer multisig (lime-gov) holds it, so the
  // unsigned tx comes from lime-gov and 2 of its 3 keys sign it (like `schedule`).
  const source = resolve(flag("source", "lime-gov"));
  const tx = await build(source, "cancel", bytesN(rest[0]), new Address(source).toScVal());
  console.error(`cancel op ${rest[0]}  canceller ${source}`);
  console.log(tx.toXDR());
} else if (CMD === "state") {
  const id = bytesN(rest[0]);
  // OperationState is a unit enum: a one-symbol vec, e.g. ["Ready"].
  const sv = scValToNative(await view("get_operation_state", id));
  const state = Array.isArray(sv) ? sv[0] : sv;
  const ready = Number(scValToNative(await view("get_operation_ledger", id)));
  const now = (await server.getLatestLedger()).sequence;
  console.log(JSON.stringify({ state, readyLedger: ready > 1 ? ready : null, currentLedger: now }));
} else {
  throw new Error(`unknown command ${CMD}`);
}
