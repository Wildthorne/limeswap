// Local quotes (src/quote.js) vs on-chain quotes, for every route the app offers:
//   NETWORK=testnet node verify-quotes.mjs [--pairs 4] [--sizes 1,100,1e7,…]
// For every ordered token pair and every size, findRoutes(mode "local") is compared with
// findRoutes(mode "chain") (router quote / quote_route, LimeFX quote), route by route, to the unit.
// - A local "needs a simulation" is fine (the app simulates exactly those routes), but local ok
//   where the chain reverts (or vice versa with a local result) is a failure.
// - LimeFX's fee has an age surcharge that ticks up while the oracle price ages, so a LimeFX
//   route may differ by the fee's drift between our one quote per refresh and the per-route
//   simulation. Such a difference passes only if recomputing locally with the fee the chain
//   used (or ±1–3 bps for quote_route, which doesn't report it) gives the chain's amount exactly.
// - If a pool's reserves moved during a pair's check, that pair is re-checked on fresh state.
import fs from "node:fs";
import { Chain, makeConfig } from "./src/chain.js";
import { findRoutes, loadTokens } from "./src/dex.js";
import { routeAmounts } from "./src/quote.js";
import { loadState } from "./src/state.js";

const NETWORK = process.env.NETWORK || "testnet";
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const SIZES = arg("sizes", "1,7,100,10000,1e6,1e7,3.3e7,1e8,1e9,7.7e9,1e10,1e11,1e12").split(",").map((s) => BigInt(Number(s)));
const PARALLEL = Number(arg("pairs", 3));
const here = new URL(".", import.meta.url).pathname;
const json = (p) => JSON.parse(fs.readFileSync(here + p, "utf8"));
const chain = new Chain(makeConfig(NETWORK, json(`../deployed.${NETWORK}.json`), json(`../lime-amm/deployed.${NETWORK}.json`)));
const tokens = await loadTokens(chain);
const sym = (id) => tokens.find((t) => t.id === id)?.symbol ?? id.slice(0, 5);

const stats = { routes: new Set(), compared: 0, exact: 0, fallback: 0, bothFail: 0, drift: 0, driftMax: 0n, fail: 0, retries: 0, sims: 0 };
const failures = [];
// State that must not move during a pair's check: reserves, and the oracle price LimeFX uses (a new
// Reflector price every ~5 min also resets the fee's age surcharge). The fee alone may drift.
const reservesSig = (st) => JSON.stringify([...st.pools.map((p) => [p.reserveA, p.reserveB]), st.fx && [st.fx.reserveA, st.fx.reserveB, st.fx.oraclePriceRaw]], (_, x) => (typeof x === "bigint" ? x.toString() : x));

/** Does recomputing `route` locally with LimeFX fee `fee` give exactly `out`? */
function withFee(route, fee, amountIn, out) {
  const hops = route.hops.map((h) => (h.type === "fx" ? { ...h, feeBps: fee } : h));
  const a = routeAmounts(hops, route.tokens, amountIn);
  return a && a.at(-1) === out;
}

async function checkPair(tIn, tOut) {
  for (let attempt = 0; attempt < 4; attempt++) {
    chain.newEpoch();
    const st = await loadState(chain);
    const local = new Map(), onchain = new Map();
    for (const amountIn of SIZES) {
      const args = { pools: st.pools, fx: st.fx, tokenIn: tIn.id, tokenOut: tOut.id, amountIn };
      const [l, c] = await Promise.all([findRoutes(chain, { ...args, mode: "local" }), findRoutes(chain, { ...args, mode: "chain" })]);
      local.set(amountIn, l);
      onchain.set(amountIn, c);
    }
    chain.newEpoch();
    const after = await loadState(chain);
    if (reservesSig(after) !== reservesSig(st)) { stats.retries++; continue; } // a pool traded / new oracle price
    for (const amountIn of SIZES) {
      for (const lr of local.get(amountIn)) {
        const cr = onchain.get(amountIn).find((r) => r.label === lr.label);
        stats.routes.add(lr.label + sym(tIn.id) + sym(tOut.id));
        stats.compared++;
        stats.sims++;
        const where = `${sym(tIn.id)}→${sym(tOut.id)} ${lr.label} @${amountIn}`;
        if (!lr.ok) {
          if (cr.ok) stats.fallback++; else stats.bothFail++;
          continue;
        }
        if (!cr.ok) { stats.fail++; failures.push(`${where}: local ${lr.amountOut} but chain reverts (${cr.error})`); continue; }
        if (lr.amountOut === cr.amountOut && (!cr.amounts || lr.amounts.join() === cr.amounts.join())) { stats.exact++; continue; }
        const usesFx = lr.hops.some((h) => h.type === "fx");
        const fees = cr.feeBps !== undefined ? [cr.feeBps] : [1, -1, 2, -2, 3, -3].map((d) => st.fx.feeBps + d);
        const explained = usesFx && fees.find((f) => withFee(lr, f, amountIn, cr.amountOut));
        const diff = lr.amountOut > cr.amountOut ? lr.amountOut - cr.amountOut : cr.amountOut - lr.amountOut;
        if (explained !== undefined && explained !== false) {
          stats.drift++;
          if (diff > stats.driftMax) stats.driftMax = diff;
        } else {
          stats.fail++;
          failures.push(`${where}: local ${lr.amountOut} vs chain ${cr.amountOut} (diff ${diff})`);
        }
      }
    }
    return;
  }
  failures.push(`${sym(tIn.id)}→${sym(tOut.id)}: reserves kept moving, not checked`);
}

const only = arg("only", null)?.split(","); // e.g. --only XLM:LEUR,LEUR:XLM
const pairs = tokens.flatMap((a) => tokens.filter((b) => b !== a).map((b) => [a, b]))
  .filter(([a, b]) => !only || only.includes(`${a.symbol}:${b.symbol}`));
const t0 = Date.now();
console.log(`${NETWORK}: ${pairs.length} pairs × ${SIZES.length} sizes (${SIZES.join(", ")})`);
for (let i = 0; i < pairs.length; i += PARALLEL) {
  await Promise.all(pairs.slice(i, i + PARALLEL).map(([a, b]) => checkPair(a, b)));
  process.stdout.write(`\r${Math.min(i + PARALLEL, pairs.length)}/${pairs.length} pairs, ${stats.compared} quotes compared`);
}
console.log(`\n\nDistinct routes: ${stats.routes.size}; route×size quotes compared: ${stats.compared}`);
console.log(`  exact to the unit (incl. every hop amount): ${stats.exact}`);
console.log(`  LimeFX age-fee drift, explained exactly by the chain's fee: ${stats.drift} (max ${stats.driftMax} units)`);
console.log(`  local deferred to a simulation (app simulates these): ${stats.fallback}; both revert: ${stats.bothFail}`);
console.log(`  FAILURES: ${stats.fail}; pair re-checks after reserves moved: ${stats.retries}; ${Math.round((Date.now() - t0) / 1000)} s`);
for (const f of failures.slice(0, 40)) console.log("   " + f);
process.exit(stats.fail || failures.length ? 1 : 0);
