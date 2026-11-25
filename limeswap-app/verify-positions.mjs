// Batched positions (state.js `mine` + dex.js myPositions) vs each pool contract's own views.
//   NETWORK=testnet node verify-positions.mjs [G… accounts]
import fs from "node:fs";
import { Chain, makeConfig, sv } from "./src/chain.js";
import { loadTokens, myPositions } from "./src/dex.js";
import { loadState } from "./src/state.js";
import { fmtAmount } from "./src/format.js";

const NETWORK = process.env.NETWORK || "testnet";
const j = (p) => JSON.parse(fs.readFileSync(new URL(p, import.meta.url), "utf8"));
const chain = new Chain(makeConfig(NETWORK, j(`../deployed.${NETWORK}.json`), j(`../lime-amm/deployed.${NETWORK}.json`)));
const tokens = await loadTokens(chain);
const sym = (id) => tokens.find((t) => t.id === id)?.symbol ?? id.slice(0, 5);
const users = process.argv.slice(2);
let checked = 0, bad = 0;
for (const user of users) {
  const st = await loadState(chain, { account: { user }, relist: true });
  for (const p of [...(st.fx ? [st.fx] : []), ...st.pools]) {
    const bal = await chain.tryRead(p.id, "balance", sv.addr(user));
    const owed = p.type === "fx" ? { ok: true, value: [0n, 0n] } : await chain.tryRead(p.id, "owed", sv.addr(user));
    const want = { shares: bal.ok ? BigInt(bal.value) : 0n, owed: owed.ok ? owed.value.map(BigInt) : [0n, 0n] };
    const ok = p.mine && p.mine.shares === want.shares && p.mine.owed.every((x, i) => x === want.owed[i]);
    checked++; if (!ok) { bad++; console.log(`MISMATCH ${user.slice(0, 6)} ${sym(p.tokenA)}/${sym(p.tokenB)}: batched ${JSON.stringify(p.mine, (_, v) => typeof v === "bigint" ? String(v) : v)} vs contract ${want.shares}`); }
  }
  const { positions, totalUsd, allPriced } = myPositions(st.pools, st.fx, tokens);
  console.log(`\n${user.slice(0, 6)}…: ${positions.length} position(s), total ≈ $${totalUsd.toFixed(2)}${allPriced ? "" : " (some unpriced)"}`);
  for (const x of positions) console.log(`   ${sym(x.pool.tokenA)}/${sym(x.pool.tokenB)} ${x.pool.type === "fx" ? "LimeFX" : (x.pool.feeBps / 100) + "%"}: ${fmtAmount(x.shares)} LP (${(x.share * 100).toFixed(3)}%) = ${fmtAmount(x.amountA)} ${sym(x.pool.tokenA)} + ${fmtAmount(x.amountB)} ${sym(x.pool.tokenB)} ≈ $${x.usd.toFixed(2)}`);
}
console.log(`\n${checked - bad}/${checked} pool positions match the contracts`);
process.exit(bad ? 1 : 0);
