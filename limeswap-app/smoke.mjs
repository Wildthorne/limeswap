// Smoke test (Node): same chain/route modules as the web app, no browser.
//   npm run smoke                 local: quotes + one small LEUR->LUSD swap with the dev signer
//   NETWORK=testnet npm run smoke Testnet: quotes only (never sends a transaction)
// On local, keep ../lime-amm/oracle-keeper.mjs running, or LimeFX rejects the stale price.
import fs from "node:fs";
import { Chain, devSigner, makeConfig } from "./src/chain.js";
import { balanceOf, findRoutes, loadFx, loadPools, loadTokens, minOut, swapCall, tokenById } from "./src/dex.js";
import { fmtAge, fmtAmount, fmtBps, fmtPct, fmtPrice, parseAmount } from "./src/format.js";

const NETWORK = process.env.NETWORK || "local";
const here = new URL(".", import.meta.url).pathname;
const json = (p) => JSON.parse(fs.readFileSync(here + p, "utf8"));
const chain = new Chain(makeConfig(NETWORK, json(`../deployed.${NETWORK}.json`), json(`../lime-amm/deployed.${NETWORK}.json`)));

const tokens = await loadTokens(chain);
const T = Object.fromEntries(tokens.map((t) => [t.key, t]));
const [pools, fx] = await Promise.all([loadPools(chain), loadFx(chain)]);
const sym = (id) => tokenById(tokens, id).symbol;

console.log(`== ${NETWORK}: ${pools.length} LimeSwap pools`);
for (const p of pools) {
  const reg = p.regulated.some(Boolean) ? "  [compliance on]" : "";
  const twap = p.twap.price ? `, TWAP ${fmtPrice(p.twap.price)} over ${Math.round(p.twap.window / 60)} min` : ", no TWAP yet";
  console.log(`   ${sym(p.tokenA)}/${sym(p.tokenB)} ${fmtBps(p.feeBps)}: 1 ${sym(p.tokenA)} = ${fmtPrice(p.mid)} ${sym(p.tokenB)}${twap}${reg}`);
}
if (fx) {
  console.log(`== LimeFX ${sym(fx.tokenA)}/${sym(fx.tokenB)}: oracle 1 ${sym(fx.tokenA)} = ${fmtPrice(fx.oraclePrice)} ${sym(fx.tokenB)}` +
    ` (${fx.oracleAge !== null ? fmtAge(fx.oracleAge) : "?"}, max age ${fx.params.max_age}s), fee ${fx.feeBps ?? "?"} bps, amp ${fx.params.amp}` +
    (fx.quoteError ? `\n   quote error: ${fx.quoteError}` : ""));
}

async function quote(inKey, outKey, text) {
  const tIn = T[inKey], tOut = T[outKey];
  const amountIn = parseAmount(text, tIn.decimals);
  const routes = await findRoutes(chain, { pools, fx, tokenIn: tIn.id, tokenOut: tOut.id, amountIn });
  console.log(`\n== Quote ${text} ${tIn.symbol} -> ${tOut.symbol}`);
  if (!routes.length) {
    console.log("   No route: no chain of up to 4 pools (LimeSwap or LimeFX) connects these tokens.");
    return null;
  }
  for (const r of routes) {
    console.log(r.ok
      ? `   ${r === routes[0] ? "*" : " "} ${r.label}: ${fmtAmount(r.amountOut, tOut.decimals)} ${tOut.symbol} (fee ${fmtPct(r.feeFraction)}, price impact ${fmtPct(r.priceImpact, 3)})`
      : `     ${r.label}: unavailable: ${r.error}`);
  }
  return routes[0].ok ? { best: routes[0], amountIn, tIn, tOut } : null;
}

const q1 = await quote("leur", "lusd", "10");
await quote("xlm", "limeClassic", "10");
await quote("limeClassic", "lfund", "50");

if (NETWORK !== "local") {
  console.log("\n(Testnet: quotes only, no transaction sent.)");
  process.exit(0);
}

const secret = (fs.existsSync(here + ".env.local") ? fs.readFileSync(here + ".env.local", "utf8") : "").match(/^VITE_DEV_SECRET=(\S+)/m)?.[1];
if (!secret) throw new Error("No VITE_DEV_SECRET in .env.local");
const signer = devSigner(secret, NETWORK);
if (!q1) throw new Error("LEUR -> LUSD has no working route; is oracle-keeper.mjs running?");
const { best, amountIn, tIn, tOut } = q1;
const before = [await balanceOf(chain, tIn.id, signer.address), await balanceOf(chain, tOut.id, signer.address)];
const min = minOut(best.amountOut, 50);
console.log(`\n== Swap 10 LEUR -> LUSD via ${best.label} as dev signer ${signer.address.slice(0, 6)}… (min ${fmtAmount(min)} LUSD)`);
const [id, method, args] = swapCall(chain, best, signer.address, amountIn, min, await chain.now());
const { hash, result } = await chain.invoke(signer, id, method, args, (s) => console.log(`   ${s}`));
const after = [await balanceOf(chain, tIn.id, signer.address), await balanceOf(chain, tOut.id, signer.address)];
const got = Array.isArray(result) ? result.at(-1) : result;
console.log(`   OK ${hash}`);
console.log(`   received ${fmtAmount(got)} LUSD; balances LEUR ${fmtAmount(before[0])} -> ${fmtAmount(after[0])}, LUSD ${fmtAmount(before[1])} -> ${fmtAmount(after[1])}`);

// The best route above may be the plain pool; also exercise LimeFX's own swap() once.
const fxRoute = (await findRoutes(chain, { pools, fx, tokenIn: tIn.id, tokenOut: tOut.id, amountIn: 10n ** 7n })).find((r) => r.venue === "fx");
if (best.venue !== "fx" && fxRoute?.ok) {
  const fxMin = minOut(fxRoute.amountOut, 50);
  console.log(`\n== Swap 1 LEUR -> LUSD via LimeFX (oracle 1 LEUR = ${fmtPrice(fxRoute.mid)} LUSD, fee ${fxRoute.feeBps} bps)`);
  const [fid, fm, fargs] = swapCall(chain, fxRoute, signer.address, 10n ** 7n, fxMin, await chain.now());
  const r = await chain.invoke(signer, fid, fm, fargs);
  console.log(`   OK ${r.hash}: received ${fmtAmount(r.result)} LUSD`);
} else if (!fxRoute?.ok) {
  console.log(`\nLimeFX unavailable: ${fxRoute?.error ?? "no LimeFX pair"}`);
}
