// End-to-end test (Node): the app's own chain/route/liquidity code, signing with the dev signer,
// every result checked against real balance changes on-chain. Lets Claude test without a wallet.
//   npm run e2e                     Testnet, as CLI identity limeswap-qa (VITE_DEV_SECRET_TESTNET)
//   NETWORK=local npm run e2e       local network, as limeswap-tester (VITE_DEV_SECRET)
// Fund the account first: ./fund-tester.sh testnet|local. Uses small amounts of test tokens only.
import fs from "node:fs";
import { Chain, devSigner, makeConfig, sv } from "./src/chain.js";
import {
  balanceOf, depositCall, findRoutes, loadFx, loadPools, loadTokens, minOut, pairedAmount, position,
  swapCall, withdrawCall,
} from "./src/dex.js";
import { faucetClaimCall, kycDesk, kycStatus, kycVerifyCall, onboardingState, trustStatus } from "./src/dex.js";
import { execSync } from "node:child_process";
import { fmtAmount } from "./src/format.js";
import { Keypair } from "@stellar/stellar-sdk";

const NETWORK = process.env.NETWORK || "testnet";
const here = new URL(".", import.meta.url).pathname;
const json = (p) => JSON.parse(fs.readFileSync(here + p, "utf8"));
const VAR = NETWORK === "testnet" ? "VITE_DEV_SECRET_TESTNET" : "VITE_DEV_SECRET";
const env = fs.existsSync(here + ".env.local") ? fs.readFileSync(here + ".env.local", "utf8") : "";
const secret = env.match(new RegExp(`^${VAR}=(\\S+)`, "m"))?.[1];
if (!secret) throw new Error(`No ${VAR} in .env.local: run ./fund-tester.sh ${NETWORK}`);

const chain = new Chain(makeConfig(NETWORK, json(`../deployed.${NETWORK}.json`), json(`../lime-amm/deployed.${NETWORK}.json`)));
const signer = devSigner(secret, NETWORK);
const me = signer.address;
const tokens = await loadTokens(chain);
const T = Object.fromEntries(tokens.map((t) => [t.key, t]));
const ONE = 10n ** 7n;
const results = [];

async function step(name, fn) {
  process.stdout.write(`\n== ${name}\n`);
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
    console.log(`   PASS ${detail}`);
  } catch (e) {
    results.push({ name, ok: false, detail: e.message });
    console.log(`   FAIL ${e.message}`);
  }
}
const check = (cond, msg) => { if (!cond) throw new Error(msg); };
const FEE_ROOM = ONE; // XLM also pays the network fee (< 1 XLM): balance changes may differ by that much
/** A balance change `delta` equals `expected`, exactly for tokens, within the fee for XLM (which only pays). */
const same = (t, delta, expected) => (t.native ? expected - delta >= 0n && expected - delta < FEE_ROOM : delta === expected);
const bal = (t) => balanceOf(chain, t.id, me);
const send = (call) => chain.invoke(signer, ...call, (s) => console.log(`   ${s}`));
const fresh = async () => {
  const [pools, fx] = await Promise.all([loadPools(chain), loadFx(chain)]);
  return { pools, fx };
};

/** Swap `text` of tIn → tOut along the best route of `venue` (or the overall best); check balances. */
async function swap(tIn, tOut, units, venue) {
  const { pools, fx } = await fresh();
  const amountIn = BigInt(units) * ONE;
  const routes = (await findRoutes(chain, { pools, fx, tokenIn: tIn.id, tokenOut: tOut.id, amountIn })).filter((r) => r.ok);
  const route = venue ? routes.find((r) => r.venue === venue) : routes[0];
  check(route, `no working ${venue ?? ""} route ${tIn.symbol} → ${tOut.symbol}`);
  const min = minOut(route.amountOut, 50);
  const [b0in, b0out] = [await bal(tIn), await bal(tOut)];
  const { hash, result } = await send(swapCall(chain, route, me, amountIn, min, await chain.now()));
  const [b1in, b1out] = [await bal(tIn), await bal(tOut)];
  const got = b1out - b0out;
  const reported = BigInt(Array.isArray(result) ? result.at(-1) : result);
  // XLM also pays the network fee, so allow a small extra decrease on the input side.
  const spent = b0in - b1in;
  check(tIn.native ? spent >= amountIn && spent < amountIn + ONE : spent === amountIn, `spent ${spent}, expected ${amountIn}`);
  check(got === reported, `received ${got} but the contract reported ${reported}`);
  check(got >= min, `received ${got} below minimum ${min}`);
  return `${route.label}: ${units} ${tIn.symbol} → ${fmtAmount(got)} ${tOut.symbol} (quote ${fmtAmount(route.amountOut)}, tx ${hash.slice(0, 10)}…)`;
}

/** Deposit `units` of token A (B paired at the pool ratio) through the router, then withdraw half. */
async function depositWithdraw(pickPool, units) {
  const { pools, fx } = await fresh();
  const pool = pickPool(pools, fx);
  check(pool, "pool not found");
  const [tA, tB] = [tokens.find((t) => t.id === pool.tokenA), tokens.find((t) => t.id === pool.tokenB)];
  const a = BigInt(units) * ONE, b = pairedAmount(pool, "a", a);
  const before = { a: await bal(tA), b: await bal(tB), lp: (await position(chain, pool, me)).shares };
  const dep = await send(depositCall(chain, pool, me, a, b, 100, await chain.now()));
  const [usedA, usedB, shares] = dep.result.map(BigInt);
  const mid = { a: await bal(tA), b: await bal(tB), lp: (await position(chain, pool, me)).shares };
  check(same(tA, -(before.a - mid.a), -usedA) && same(tB, -(before.b - mid.b), -usedB), "token balances moved by a different amount than reported");
  check(usedA <= a && usedB <= b && usedA >= minOut(a, 100) && usedB >= minOut(b, 100), "deposit outside signed amounts / minimums");
  check(mid.lp - before.lp === shares && shares > 0n, "LP shares not credited");
  // Withdraw half of what we just got.
  const refreshed = pool.type === "fx" ? (await fresh()).fx : (await fresh()).pools.find((p) => p.id === pool.id);
  const wd = await send(withdrawCall(refreshed, me, shares / 2n, 100));
  const [outA, outB] = wd.result.map(BigInt);
  const after = { a: await bal(tA), b: await bal(tB), lp: (await position(chain, pool, me)).shares };
  check(same(tA, after.a - mid.a, outA) && same(tB, after.b - mid.b, outB), "withdrawn amounts don't match balance changes");
  check(mid.lp - after.lp === shares / 2n, "LP shares not burned");
  return `deposit ${fmtAmount(usedA)} ${tA.symbol} + ${fmtAmount(usedB)} ${tB.symbol} → ${fmtAmount(shares)} LP; ` +
    `withdraw half → ${fmtAmount(outA)} ${tA.symbol} + ${fmtAmount(outB)} ${tB.symbol}`;
}

/** A brand-new visitor (throwaway key, never stored): Friendbot → trustlines → faucet → first swap. */
async function newVisitor() {
  const kp = Keypair.random();
  const v = devSigner(kp.secret(), NETWORK);
  const st0 = await onboardingState(chain, tokens, v.address);
  check(!st0.funded, "fresh account already exists?");
  await chain.fundWithFriendbot(v.address);
  const st1 = await onboardingState(chain, tokens, v.address);
  check(st1.funded && st1.missing.length > 0, "after Friendbot: expected funded + missing trustlines");
  await chain.addTrustlines(v, st1.missing.map((m) => m.asset), (s) => console.log(`   ${s}`));
  const st2 = await onboardingState(chain, tokens, v.address);
  check(st2.missing.length === 0 && st2.faucet.nextClaim === 0, "trustlines missing or claim unavailable");
  await chain.invoke(v, ...faucetClaimCall(chain, v.address), (s) => console.log(`   ${s}`));
  for (const d of st2.faucet.drips) {
    check((await balanceOf(chain, d.token, v.address)) === d.amount, `faucet didn't pay ${tokens.find((t) => t.id === d.token)?.symbol}`);
  }
  const again = await chain.invoke(v, ...faucetClaimCall(chain, v.address)).then(() => "paid twice", (e) => e.message);
  check(/already claimed/i.test(again), `second claim should be refused, got: ${again}`);
  // First trade with the claimed tokens, through the app's routing.
  const { pools, fx } = await fresh();
  const routes = (await findRoutes(chain, { pools, fx, tokenIn: T.leur.id, tokenOut: T.lusd.id, amountIn: 10n * ONE })).filter((r) => r.ok);
  const r = await chain.invoke(v, ...swapCall(chain, routes[0], v.address, 10n * ONE, minOut(routes[0].amountOut, 50), await chain.now()));
  return `new account ${v.address.slice(0, 6)}…: Friendbot, ${st1.missing.length} trustlines (${st1.missing.map((m) => m.token.symbol).join(", ")}) in one tx, ` +
    `faucet ${st2.faucet.drips.map((d) => fmtAmount(d.amount) + " " + tokens.find((t) => t.id === d.token)?.symbol).join(" + ")}, ` +
    `2nd claim refused ("${again.split(".")[0]}"), first swap 10 LEUR → ${fmtAmount(BigInt(Array.isArray(r.result) ? r.result.at(-1) : r.result))} LUSD`;
}

/** Demo KYC: a brand-new account verifies for LFUND in one tx (trustline + approval + grant) and sells some. */
async function demoKyc() {
  check(kycDesk(chain, T.lfund), "no LFUND KYC desk in lime-amm/deployed json (run lime-amm/kyc.sh)");
  const v = devSigner(Keypair.random().secret(), NETWORK);
  await chain.fundWithFriendbot(v.address);
  check((await trustStatus(chain, T.lfund, v.address)) === "missing" && (await kycStatus(chain, T.lfund, v.address)) === "unverified", "fresh account isn't unverified");
  const { result } = await chain.invoke(v, ...kycVerifyCall(chain, T.lfund, v.address), (s) => console.log(`   ${s}`));
  const grant = BigInt(result);
  check(grant > 0n && (await balanceOf(chain, T.lfund.id, v.address)) === grant, "starter grant not paid");
  check((await trustStatus(chain, T.lfund, v.address)) === "authorized" && (await kycStatus(chain, T.lfund, v.address)) === "verified", "not approved after verify");
  const again = await chain.invoke(v, ...kycVerifyCall(chain, T.lfund, v.address)).then(() => "verified twice", (e) => e.message);
  check(/already verified/i.test(again), `second verify should be refused, got: ${again}`);
  // Sell half the grant (regulated token on the input side) through the app's routing.
  const { pools, fx } = await fresh();
  const routes = (await findRoutes(chain, { pools, fx, tokenIn: T.lfund.id, tokenOut: T.xlm.id, amountIn: grant / 2n })).filter((r) => r.ok);
  const sw = await chain.invoke(v, ...swapCall(chain, routes[0], v.address, grant / 2n, minOut(routes[0].amountOut, 50), await chain.now()));
  // An account the issuer froze (Maria, recorded Revoked by kyc.sh) is refused, even unsigned in simulation.
  let frozen = "skipped (no lime-friend key here)";
  try {
    const maria = execSync("stellar keys address lime-friend", { encoding: "utf8" }).trim();
    const r = await chain.tryRead(kycDesk(chain, T.lfund), "verify", sv.addr(maria));
    check(!r.ok && /froze/i.test(`${r.error} ${chain.explain(r.raw ?? r.error, kycDesk(chain, T.lfund))}`), `frozen Maria should be refused, got ${JSON.stringify(r).slice(0, 200)}`);
    frozen = "frozen Maria refused";
  } catch (e) {
    if (!/lime-friend|not found|No such/i.test(e.message)) throw e;
  }
  return `new account ${v.address.slice(0, 6)}…: verify → approved + ${fmtAmount(grant)} LFUND in one tx, 2nd verify refused, ` +
    `sold ${fmtAmount(grant / 2n)} LFUND → ${fmtAmount(BigInt(Array.isArray(sw.result) ? sw.result.at(-1) : sw.result))} XLM, ${frozen}`;
}

console.log(`LimeSwap e2e on ${NETWORK} as ${me} (dev signer, ${signer.prompt})`);
if (chain.config.faucet && chain.config.friendbot) await step("New visitor: Friendbot → trustlines → faucet → first swap", newVisitor);
if (chain.config.friendbot && chain.config.kyc?.lfund) await step("Demo KYC: new account verifies for LFUND, then sells some", demoKyc);
await step("Swap LEUR → LUSD (best route)", () => swap(T.leur, T.lusd, 10));
await step("Swap LUSD → LEUR through LimeFX", () => swap(T.lusd, T.leur, 10, "fx"));
await step("Mixed route XLM → LUSD → LEUR (LimeSwap + LimeFX)", () => swap(T.xlm, T.leur, 5, "mixed"));
await step("Two-hop LIME → XLM → LFUND (regulated output)", () => swap(T.limeClassic, T.lfund, 20));
await step("LimeFX: deposit via router, withdraw half", () => depositWithdraw((_, fx) => fx, 20));
await step("Compliance pool LFUND/XLM: deposit + withdraw (authorized holder)",
  () => depositWithdraw((pools) => pools.find((p) => p.regulated.some(Boolean)), 2));

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed on ${NETWORK}`);
process.exit(failed.length ? 1 : 0);
