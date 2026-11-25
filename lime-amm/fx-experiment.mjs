// Phase 3 experiment (local network only: needs the mock oracle we control).
// The real EUR/USD jumps by MOVE bps. How much can an arbitrageur take from LPs of:
//  1. LimeSwap 0.05% (plain x·y=k, shallow), arbitraged after the move;
//  2. LimeFX *before* the oracle reports the move (latency arbitrage). This is also what a pool
//     as deep as LimeFX loses on every move if it doesn't follow an oracle (Curve-style);
//  3. LimeFX *after* the oracle update.
// Every run deploys fresh pools with 10,000 LEUR + the same value of LUSD, so runs don't interfere;
// the best arbitrage trade (ternary search on on-chain quotes) is executed for real.
//
// Usage: node fx-experiment.mjs [moves=10,30,50,100] [amp=100]     (after ./fx-pool.sh local)
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const NET = "local";
const MOVES = (process.argv[2] ?? "10,30,50,100").split(",").map(BigInt);
const AMP = process.argv[3] ?? "100";
const ONE = 10_000_000n;
const S = 10n ** 14n; // oracle and pool price scale
const here = new URL(".", import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const latest = (name) => fs.readdirSync(`${here}releases`).filter((f) => f.startsWith(name + "_v")).sort().at(-1);

function sh(args) {
  for (let attempt = 1; ; attempt++) {
    try {
      return execFileSync("stellar", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    } catch (err) {
      if (attempt >= 3) throw new Error(`${args.slice(0, 6).join(" ")}: ${String(err.stderr).split("\n").slice(-3).join(" ")}`);
    }
  }
}
const cli = (...a) => sh(["contract", "invoke", "--source-account", "lime-owner", "--network", NET, ...a]);
const deploy = (wasm, ...ctor) =>
  sh(["contract", "deploy", "--wasm", `${here}releases/${latest(wasm)}`, "--source-account", "lime-owner",
    "--network", NET, "--", ...ctor]).split("\n").at(-1);
const j = (s) => JSON.parse(s);
const fmt = (u) => (Number(u) / 1e7).toFixed(2);

const d = j(fs.readFileSync(`${here}deployed.${NET}.json`, "utf8"));
const { leur: LEUR, lusd: LUSD } = d.tokens;
const ORACLE = d.fx.oracle;
const OWNER = sh(["keys", "address", "lime-owner"]);
// Contract order of the two tokens (address bytes; strkey base32 puts 2–7 after A–Z).
const key = (s) => s.replace(/[2-7]/g, (c) => "abcdef"["234567".indexOf(c)]);
const eurIsA = key(LEUR) < key(LUSD);
const [A, B] = eurIsA ? [LEUR, LUSD] : [LUSD, LEUR];

const eurPrice = () => BigInt(j(cli("--id", ORACLE, "--", "lastprice", "--asset", '{"Other":"EUR"}')).price);
const setEur = (p) => cli("--id", ORACLE, "--", "set_price", "--asset", '{"Other":"EUR"}', "--price", p.toString(),
  "--timestamp", Math.floor(Date.now() / 1000).toString());
function reserves(id) { // (eur, usd)
  const i = j(cli("--id", id, "--", "info"));
  return eurIsA ? [BigInt(i.reserve_a), BigInt(i.reserve_b)] : [BigInt(i.reserve_b), BigInt(i.reserve_a)];
}
const value = ([eur, usd], p) => (eur * p) / S + usd; // in LUSD units

function freshPools(p) {
  const usd = (10_000n * ONE * p) / S;
  const [da, db] = eurIsA ? [10_000n * ONE, usd] : [usd, 10_000n * ONE];
  const [aa, ab] = eurIsA ? ['{"Other":"EUR"}', '{"Other":"USD"}'] : ['{"Other":"USD"}', '{"Other":"EUR"}'];
  const cp = deploy("lime_amm_pool", "--admin", OWNER, "--token_a", A, "--token_b", B, "--fee_bps", "5");
  // Price band ±30% around today's price (LimeFX refuses to trade outside it).
  const band = eurIsA ? [(p * 7n) / 10n, (p * 13n) / 10n] : [(S * S * 10n) / (p * 13n), (S * S * 10n) / (p * 7n)];
  const fx = deploy("lime_amm_fx_pool", "--admin", OWNER, "--token_a", A, "--token_b", B, "--oracle", ORACLE,
    "--asset_a", aa, "--asset_b", ab, "--base_fee_bps", "5", "--amp", AMP,
    "--min_price", band[0].toString(), "--max_price", band[1].toString());
  for (const id of [cp, fx]) {
    cli("--id", id, "--", "deposit", "--from", OWNER, "--desired_a", da.toString(), "--desired_b", db.toString(),
      "--min_a", da.toString(), "--min_b", db.toString());
  }
  return { cp, fx };
}

// Ternary search for the most profitable LUSD → LEUR trade, valued at the new price p.
function best(quote, p, hi) {
  const profit = (x) => (quote(x) * p) / S - x;
  let lo = ONE, h = hi;
  for (let k = 0; k < 20 && h - lo > ONE; k++) {
    const m1 = lo + (h - lo) / 3n, m2 = h - (h - lo) / 3n;
    if (profit(m1) < profit(m2)) lo = m1; else h = m2;
  }
  const x = (lo + h) / 2n;
  return { x, profit: profit(x) };
}

const results = [];
for (const MOVE of MOVES) {
  const p0 = eurPrice();
  for (let k = 0; k < 7; k++) { await sleep(1100); setEur(p0); } // calm history → base fee
  const { cp, fx } = freshPools(p0);
  const p1 = (p0 * (10_000n + MOVE)) / 10_000n;
  const quoteOf = (id) => (x) => BigInt(j(cli("--id", id, "--", "quote", "--token_in", LUSD, "--amount_in", x.toString())).amount_out);
  const swapOf = (id) => (x) => cli("--id", id, "--", "swap", "--from", OWNER, "--to", OWNER, "--token_in", LUSD,
    "--amount_in", x.toString(), "--min_out", "0");
  const feeOf = (id) => j(cli("--id", id, "--", "quote", "--token_in", LUSD, "--amount_in", (100n * ONE).toString())).fee_bps;
  const cpQuote = (x) => BigInt(j(cli("--id", cp, "--", "get_amount_out", "--token_in", LUSD, "--amount_in", x.toString())));
  const row = { moveBps: Number(MOVE), feeBefore: feeOf(fx) };
  const run = (name, id, quote, swap) => {
    const r0 = reserves(id);
    const b = best(quote, p1, 6_000n * ONE);
    if (b.profit > 0n) swap(b.x);
    const loss = value(r0, p1) - value(reserves(id), p1); // vs. simply holding through the move
    row[name] = `${fmt(b.profit > 0n ? b.profit : 0n)} (${((Number(loss) / Number(value(r0, p1))) * 1e4).toFixed(2)} bps)`;
  };
  run("LimeFX before oracle update", fx, quoteOf(fx), swapOf(fx));
  run("LimeSwap x·y=k", cp, cpQuote, swapOf(cp));
  await sleep(1100);
  setEur(p1);
  // A fresh LimeFX for the "after" case, so the latency trade above doesn't pre-empt it.
  const fresh = freshPools(p0).fx;
  row.feeAfter = feeOf(fresh);
  run("LimeFX after oracle update", fresh, quoteOf(fresh), swapOf(fresh));
  await sleep(1100);
  setEur(p0); // back to the starting price for the next run
  results.push(row);
  console.log(row);
}
console.log(`\nArbitrage profit in LUSD (LP loss vs holding, in bps of pool value); pools of ~21,000 LUSD, amp ${AMP}`);
console.table(results);
fs.appendFileSync(`${here}runs-fx-experiment.jsonl`, JSON.stringify({ at: new Date().toISOString(), amp: AMP, results }) + "\n");
