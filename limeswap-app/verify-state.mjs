// Check the batched storage reads (src/state.js) against the contracts' own views, field by field:
//   NETWORK=testnet node verify-state.mjs [G-address …]
// Pools: info() / compliance() / paused(); LimeFX: info() / paused() / outflow_cap() / flow();
// tokens: decimals(); accounts: SAC balance() / authorized() vs the batched account + trustline read.
// A pool that traded between the two reads is re-checked (state moved, not a decoding error).
import fs from "node:fs";
import { Chain, makeConfig, sv } from "./src/chain.js";
import { balanceOf, loadPool, loadTokens, trustStatus } from "./src/dex.js";
import { loadState } from "./src/state.js";

const NETWORK = process.env.NETWORK || "testnet";
const here = new URL(".", import.meta.url).pathname;
const json = (p) => JSON.parse(fs.readFileSync(here + p, "utf8"));
const chain = new Chain(makeConfig(NETWORK, json(`../deployed.${NETWORK}.json`), json(`../lime-amm/deployed.${NETWORK}.json`)));
const j = (v) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));
let checks = 0, bad = 0;
const eq = (what, a, b) => {
  checks++;
  if (j(a) !== j(b)) {
    bad++;
    console.log(`   MISMATCH ${what}: storage ${j(a)} vs view ${j(b)}`);
    return false;
  }
  return true;
};

const tokens = await loadTokens(chain);
for (const t of tokens) eq(`${t.symbol} decimals`, t.decimals, Number(await chain.simulate(t.id, "decimals", [])));
for (const t of tokens.filter((t) => t.classic && !t.native)) eq(`${t.symbol} name`, chain.classic.get(t.id), await chain.simulate(t.id, "name", []));

for (let attempt = 1; attempt <= 3; attempt++) {
  chain.newEpoch();
  const before = bad;
  const st = await loadState(chain, { relist: true });
  console.log(`== attempt ${attempt}: ledger ${st.ledger}, ${st.pools.length} pools`);
  for (const p of st.pools) {
    chain.newEpoch();
    const ref = await loadPool(chain, p.id);
    for (const f of ["tokenA", "tokenB", "reserveA", "reserveB", "feeBps", "totalShares", "regulated", "paused", "mid"]) eq(`${p.id.slice(0, 6)} ${f}`, p[f], ref[f]);
  }
  if (st.fx) {
    const f = st.fx;
    const [info, paused, cap, flow] = await Promise.all(["info", "paused", "outflow_cap", "flow"].map((m) => chain.simulate(f.id, m, [])));
    for (const [k, v] of [["tokenA", info.token_a], ["tokenB", info.token_b], ["reserveA", info.reserve_a], ["reserveB", info.reserve_b],
      ["totalShares", info.total_shares], ["oracle", info.oracle], ["assetA", info.asset_a], ["assetB", info.asset_b], ["params", info.params], ["paused", paused]]) {
      eq(`LimeFX ${k}`, f[k], v);
    }
    eq("LimeFX outflow cap", [f.outflowCap.capBps, f.outflowCap.window], [cap.cap_bps, BigInt(cap.window)]);
    // flow() returns a fresh window once the stored one expired; compare only a live window.
    if (f.flow && BigInt(f.now) < f.flow.start + f.outflowCap.window) {
      eq("LimeFX flow", [f.flow.start, f.flow.baseA, f.flow.baseB, f.flow.netOutA, f.flow.netOutB], [flow.start, flow.base_a, flow.base_b, flow.net_out_a, flow.net_out_b].map(BigInt));
    }
    const base = await chain.simulate(f.oracle, "base", []);
    eq("oracle base", f.oracleBase, base);
    eq("oracle decimals", f.oracleDecimals, Number(await chain.simulate(f.oracle, "decimals", [])));
    console.log(`   LimeFX exact local pricing: ${f.exact}; fee ${f.feeBps} bps; oracle ${f.oraclePrice} (age ${f.oracleAge}s)`);
  }
  if (bad === before) break;
  console.log("   (some fields differed: the pools may have traded between reads; retrying)");
  if (attempt < 3) bad = before;
}

// Accounts: batched balances / trustline status vs simulated SAC balance() / authorized().
const users = process.argv.slice(2);
for (const u of users) {
  chain.newEpoch();
  for (const t of tokens) {
    const batched = await balanceOf(chain, t.id, u);
    const r = await chain.tryRead(t.id, "balance", sv.addr(u));
    eq(`${u.slice(0, 6)} ${t.symbol} balance`, batched, r.ok ? BigInt(r.value) : null);
    if (t.classic && !t.native) {
      const ts = await trustStatus(chain, t, u);
      const a = await chain.tryRead(t.id, "authorized", sv.addr(u));
      const ref = a.ok ? (a.value ? "authorized" : "frozen") : /#13\b|trustline/i.test(a.raw ?? a.error) ? "missing" : "unknown";
      eq(`${u.slice(0, 6)} ${t.symbol} trust`, ts, ref);
    }
  }
  console.log(`== account ${u.slice(0, 6)}… checked`);
}

console.log(`\n${checks - bad}/${checks} fields match${bad ? ` (${bad} MISMATCHES)` : ""}`);
process.exit(bad ? 1 : 0);
