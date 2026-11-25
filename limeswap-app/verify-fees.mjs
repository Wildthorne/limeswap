// Checks src/fees.js against the chain (read-only): rebuilds every pool's history from its events
// and compares it with what the contracts themselves report.
//   NETWORK=testnet node verify-fees.mjs [G… account]
// 1. LimeSwap pools: our reserve sums agree with every `sync` event (mismatches = 0).
// 2. Each LimeSwap swap: the x·y=k formula with our rebuilt reserves and the pool's fee gives
//    the amount the pool actually paid (exact for router swaps, never less).
// 3. Pools created inside the RPC window rebuild back to exactly zero (LimeFX too: no sync there,
//    so this is its end-to-end check of every swap/deposit/withdraw amount).
// 4. Fee totals recomputed straight from the raw events, without the module, match.
// 5. With an account: its position now matches myPositions (the Liquidity tab's numbers).
import fs from "node:fs";
import { Chain, makeConfig } from "./src/chain.js";
import { loadState, loadTokens, myPositions, tokenById, usdPrices } from "./src/dex.js";
import { feeOf, loadHistory, poolEarnings, poolsAt, poolTxs, priceEarnings } from "./src/fees.js";
import { cpOut } from "./src/quote.js";

const NETWORK = process.env.NETWORK || "testnet";
const USER = process.argv[2] ?? null;
const here = new URL(".", import.meta.url).pathname;
const json = (p) => JSON.parse(fs.readFileSync(here + p, "utf8"));
const chain = new Chain(makeConfig(NETWORK, json(`../deployed.${NETWORK}.json`), json(`../lime-amm/deployed.${NETWORK}.json`)));

const tokens = await loadTokens(chain);
// Same read as the app: every pool (and the account's LP shares) in one batch, at one ledger.
const { pools, fx, ledger: atLedger } = await loadState(chain, { account: USER ? { user: USER } : null });
const all = [...(fx ? [fx] : []), ...pools];
const t0 = Date.now();
const h = await loadHistory(chain.server, all.map((p) => p.id), { upTo: atLedger });
console.log(`== ${NETWORK}: ${h.events.length} pool events, ledgers ${h.fromLedger}…${h.toLedger - 1} (${((h.toAt - h.fromAt) / 86400).toFixed(2)} days), fetched in ${Date.now() - t0} ms; state at ledger ${atLedger}`);

const sym = (id) => tokenById(tokens, id).symbol;
const dec = (id) => tokenById(tokens, id).decimals;
const prices = usdPrices(pools, fx, tokens);
const usd = (id, raw) => (prices.has(id) ? (Number(raw) / 10 ** dec(id)) * prices.get(id) : NaN);
const units = (raw, id) => (Number(raw) / 10 ** dec(id)).toFixed(4);
const now = Math.floor(Date.now() / 1000);
let problems = 0;
const bad = (msg) => { problems++; console.log(`   ✗ ${msg}`); };

for (const p of all) {
  const name = `${sym(p.tokenA)}/${sym(p.tokenB)} ${p.type === "fx" ? "LimeFX" : `${p.feeBps / 100}%`}`;
  const { txs, mismatches } = poolTxs(p, h.events, atLedger);
  console.log(`\n== ${name}  (${txs.length} txs)`);
  if (!txs.length) { console.log("   no activity in the window"); continue; }
  // 1
  if (p.type !== "fx") (mismatches ? bad(`${mismatches} sync mismatches`) : console.log("   ✓ reserves agree with all sync events"));
  // 2
  if (p.type !== "fx") {
    let exact = 0, worse = 0, n = 0;
    for (const t of txs) for (const s of t.swaps) {
      if (t.swaps.length > 1) continue; // several swaps in one tx: pre-state per swap unknown
      n++;
      const aIn = s.inA > 0n;
      const quoted = aIn ? cpOut(s.inA, t.pre.a, t.pre.b, s.feeBps) : cpOut(s.inB, t.pre.b, t.pre.a, s.feeBps);
      const paid = aIn ? s.outB : s.outA;
      if (quoted === paid) exact++;
      else if (paid > quoted) { worse++; bad(`swap in tx ${t.tx.slice(0, 8)} paid ${paid}, formula allows ${quoted}`); }
    }
    console.log(`   ✓ ${n} swaps: ${exact} paid exactly the x·y=k amount, ${n - exact - worse} less (direct swaps asking for less), ${worse} more`);
  }
  // 3
  const first = txs[0].pre;
  if (first.s === 0n) {
    (first.a === 0n && first.b === 0n) ? console.log(`   ✓ created in the window; rebuilds back to exactly 0 / 0 / 0 shares`) : bad(`created in the window but rebuilds to ${first.a} / ${first.b}`);
  } else console.log(`   (older than the window: starts at ${units(first.a, p.tokenA)} ${sym(p.tokenA)} / ${units(first.b, p.tokenB)} ${sym(p.tokenB)})`);
  // 4
  const e = poolEarnings(p, h, { now, atLedger, user: USER, shares: p.mine?.shares ?? 0n });
  if (!e) { console.log("   no liquidity in the window"); continue; }
  let fa = 0n, fb = 0n;
  for (const ev of h.events) {
    if (ev.contract !== p.id || ev.name !== "swap" || ev.at <= e.since || ev.ledger > atLedger) continue;
    fa += feeOf(ev.data.in_a, ev.data.fee_bps ?? p.feeBps);
    fb += feeOf(ev.data.in_b, ev.data.fee_bps ?? p.feeBps);
  }
  (fa === e.feesA && fb === e.feesB) ? console.log("   ✓ fee totals match a direct sum over the raw swap events") : bad(`fees ${e.feesA}/${e.feesB} vs raw ${fa}/${fb}`);
  const v = priceEarnings(p, e, usd);
  console.log(`   fees since ${new Date(e.since * 1000).toISOString().slice(0, 16)} (${e.days.toFixed(2)} d, ${e.swaps} swaps): ${units(e.feesA, p.tokenA)} ${sym(p.tokenA)} + ${units(e.feesB, p.tokenB)} ${sym(p.tokenB)} ≈ $${v.feesUsd.toFixed(4)}; 24 h ≈ $${v.fees24Usd.toFixed(4)}; TVL ≈ $${v.tvlUsd.toFixed(2)}; APR ${v.apr === null ? "– (under a day)" : (v.apr * 100).toFixed(2) + "%"}`);
  // 5
  if (e.user) {
    const mp = myPositions(pools, fx, tokens).positions.find((x) => x.pool.id === p.id);
    (mp && mp.amountA === e.user.nowA && mp.amountB === e.user.nowB) ? console.log("   ✓ position now matches the Liquidity tab (myPositions)") : bad("position differs from myPositions");
    const u = v.user;
    // Entry value at that moment's prices (same as src/ui/earnings.js compute()).
    const then = poolsAt(pools, fx, h, e.user.since, atLedger);
    const pr = usdPrices(then.pools, then.fx, tokens);
    const usdThen = (id, raw) => (pr.has(id) ? (Number(raw) / 10 ** dec(id)) * pr.get(id) : NaN);
    const entry = usdThen(p.tokenA, e.user.startA) + usdThen(p.tokenB, e.user.startB);
    const pa = (id) => (pr.has(id) ? pr.get(id).toFixed(4) : "?");
    console.log(`   entry ${e.user.known ? "(your own deposit/withdrawal)" : "(history start; position is older)"} ${new Date(e.user.since * 1000).toISOString().slice(0, 16)}: ${units(e.user.startA, p.tokenA)} ${sym(p.tokenA)} @ $${pa(p.tokenA)} + ${units(e.user.startB, p.tokenB)} ${sym(p.tokenB)} @ $${pa(p.tokenB)} = $${entry.toFixed(2)} → now $${u.nowUsd.toFixed(2)} (${u.nowUsd >= entry ? "+" : ""}${(u.nowUsd - entry).toFixed(2)}, ${(((u.nowUsd - entry) / entry) * 100).toFixed(1)}%)`);
    console.log(`   you since ${new Date(e.user.since * 1000).toISOString().slice(0, 16)}: fees ≈ $${u.feesUsd.toFixed(4)}, price effect ≈ $${u.priceUsd.toFixed(4)}, vs holding ≈ $${u.vsHoldUsd.toFixed(4)} (now $${u.nowUsd.toFixed(2)}, hold $${u.holdUsd.toFixed(2)})`);
  }
}
console.log(problems ? `\n${problems} problem(s)` : "\nAll checks passed.");
process.exit(problems ? 1 : 0);
