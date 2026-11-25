// LimeSwap + LimeFX data and routing. Plain ES module (no DOM): used by the app and by smoke.mjs.
import { PRICE_SCALE, ratio } from "./format.js";
import { sv } from "./chain.js";
import { routeAmounts } from "./quote.js";
import { accountState, classicAssets, loadState, loadTwaps, tokenMetadata, tokensCached } from "./state.js";

export { loadState, loadTwaps, tokensCached };

export const FEE_TIERS = [5, 30, 100];
const LABELS = { xlm: "XLM", limeClassic: "LIME", limeContract: "LIME·c", lfund: "LFUND", leur: "LEUR", lusd: "LUSD" };
const NOTES = {
  xlm: "Stellar's native asset",
  limeClassic: "needs a one-time opt-in (trustline)",
  limeContract: "LIME as a smart-contract token: no opt-in needed",
  lfund: "regulated fund token: issuer must authorize holders",
  leur: "test euro stablecoin",
  lusd: "test dollar stablecoin",
};

/**
 * Token list with decimals (and classic asset names) from chain. Order = display order.
 * Read once from the token contracts' storage in one request, then cached (they never change).
 */
export async function loadTokens(chain) {
  const entries = Object.entries(chain.config.tokens);
  const meta = await tokenMetadata(chain, entries.map(([, id]) => id));
  const tokens = entries.map(([key, id]) => ({
    key, id, symbol: LABELS[key] ?? key, note: NOTES[key] ?? "", decimals: Number(meta.get(id)?.decimals ?? 7),
    classic: key !== "limeContract", // SACs of classic assets: trustlines + issuer authorization apply
    native: key === "xlm",
  }));
  // Classic asset "CODE:ISSUER" of each SAC (its name()): for trustlines and batched balances.
  chain.classic = new Map();
  for (const t of tokens) {
    const name = meta.get(t.id)?.name;
    if (t.classic && !t.native && name && name.includes(":")) {
      assetNames.set(t.id, name);
      chain.classic.set(t.id, name);
    } else if (t.native) chain.classic.set(t.id, "native");
  }
  return tokens;
}

export const tokenById = (tokens, id) => tokens.find((t) => t.id === id) ?? { id, symbol: id.slice(0, 5) + "…", decimals: 7 };

/**
 * Every pool registered in the factory, with reserves, prices, TWAP and compliance flags.
 * State comes from one batched ledger read (see state.js). `twap: false` skips the TWAP
 * simulations (the app loads them lazily for the Pools tab: p.twap is then { pending: true }).
 */
export async function loadPools(chain, { twap = true } = {}) {
  const { pools } = await loadState(chain);
  if (twap) await loadTwaps(chain, pools);
  return pools;
}

/** One pool by simulation (info, twap, compliance, paused): the pre-batching reference reader. */
export async function loadPool(chain, id) {
  chain.kinds.set(id, "pool");
  const [info, twap, compliance, paused] = await Promise.all([
    chain.read(id, "info"),
    chain.tryRead(id, "twap", sv.u64(600)),
    chain.tryRead(id, "compliance"),
    chain.tryRead(id, "paused"),
  ]);
  const p = {
    type: "limeswap", id,
    tokenA: info.token_a, tokenB: info.token_b,
    reserveA: BigInt(info.reserve_a), reserveB: BigInt(info.reserve_b),
    feeBps: Number(info.fee_bps), totalShares: BigInt(info.total_shares),
    regulated: compliance.ok ? compliance.value : [false, false],
    paused: paused.ok ? paused.value : false,
  };
  p.mid = ratio(p.reserveB, p.reserveA); // price of A in B (same decimals)
  if (twap.ok) {
    const [aInB, , window] = twap.value;
    p.twap = { price: Number(aInB) / Number(PRICE_SCALE), window: Number(window) };
  } else {
    p.twap = { error: twap.error };
  }
  return p;
}

/** LimeFX: reserves, parameters, oracle price + age, and the current fee (from one tiny quote). */
export async function loadFx(chain) {
  if (!chain.config.fx?.pool) return null;
  const { fx, fxError } = await loadState(chain);
  if (!fx) throw new Error(fxError);
  return fx;
}

// ---------- Routing ----------

const MAX_HOPS = 4; // LIME·c → LEUR is the longest pair today (4 hops); each hop is a few M instructions

/**
 * All candidate routes from `tokenIn` to `tokenOut` for `amountIn`: every path of up to MAX_HOPS
 * pools (LimeSwap fee tiers and LimeFX) that never revisits a token. Pairs with no shared
 * neighbour (LIME → LEUR = LIME → XLM → LUSD → LEUR) need 3 hops; router v2 takes any length.
 * Quoted locally with the contracts' exact integer maths on the latest state (src/quote.js), so
 * no simulation per route. A route is simulated instead when the local maths can't be sure
 * (LimeFX oracle unavailable, outflow cap, zero amounts, …): LimeSwap-only paths with the
 * router's `quote`, a single LimeFX hop with LimeFX's `quote`, mixed paths with `quote_route`.
 * `mode`: "auto" (default), "chain" (always simulate) or "local" (never: ok:false instead).
 * Returns candidates sorted best-first; failed quotes are kept (ok:false) to show why.
 */
export async function findRoutes(chain, { pools, fx, tokenIn, tokenOut, amountIn, mode = "auto" }) {
  const venues = pools.filter((p) => p.totalShares > 0n);
  if (fx) venues.push(fx);
  const other = (p, t) => (p.tokenA === t ? p.tokenB : p.tokenB === t ? p.tokenA : null);
  const paths = [];
  const walk = (hops, tokens) => {
    const at = tokens.at(-1);
    for (const p of venues) {
      const next = other(p, at);
      if (!next || tokens.includes(next)) continue;
      if (next === tokenOut) paths.push({ hops: [...hops, p], tokens: [...tokens, next] });
      else if (hops.length + 1 < MAX_HOPS) walk([...hops, p], [...tokens, next]);
    }
  };
  walk([], [tokenIn]);
  amountIn = BigInt(amountIn);

  const quotes = paths.map(async (path) => {
    const usesFx = path.hops.some((h) => h.type === "fx");
    const venue = !usesFx ? "limeswap" : path.hops.length === 1 ? "fx" : "mixed";
    const fees = path.hops.map((h) => h.feeBps);
    const base = { venue, ...path, fees, label: routeLabel(chain, path) };
    if (path.hops.some((h) => h.paused)) return { ...base, ok: false, error: "A pool on this route is paused." };
    const local = mode === "chain" ? null : routeAmounts(path.hops, path.tokens, amountIn);
    if (local) return { ...quoted(base, local, amountIn, fx), quotedBy: "local" };
    if (mode === "local") return { ...base, ok: false, error: "needs a simulation", quotedBy: "local" };
    return { ...(await simulateRoute(chain, base, tokenIn, amountIn, fx)), quotedBy: "chain" };
  });

  const all = await Promise.all(quotes);
  return all.sort((a, b) => (a.ok !== b.ok ? (a.ok ? -1 : 1) : a.ok ? (b.amountOut > a.amountOut ? 1 : b.amountOut < a.amountOut ? -1 : 0) : 0));
}

/** Route result from hop amounts (local or simulated), with mid price and fee along the path. */
function quoted(base, amounts, amountIn, fx, feeBps) {
  const out = amounts.at(-1);
  if (base.venue === "fx") {
    const f = feeBps ?? fx.feeBps;
    const mid = fxMid(fx, base.tokens[0], fx.oraclePriceRaw);
    return finish({ ...base, ok: true, amountOut: out, mid, feeBps: f, feeFraction: f / 10_000 }, amountIn);
  }
  // Mid price along the path (before fees and price impact): reserve ratio for LimeSwap
  // hops, the oracle price for LimeFX.
  let mid = 1, keep = 1;
  base.hops.forEach((h, i) => {
    const t = base.tokens[i];
    if (h.type === "fx") mid *= t === h.tokenA ? h.oraclePrice : 1 / h.oraclePrice;
    else mid *= t === h.tokenA ? ratio(h.reserveB, h.reserveA) : ratio(h.reserveA, h.reserveB);
    keep *= 1 - (h.feeBps ?? 0) / 10_000;
  });
  return finish({ ...base, ok: true, amountOut: out, mid, feeFraction: 1 - keep, amounts }, amountIn);
}

const fxMid = (fx, tokenIn, oraclePriceRaw) => {
  const priceAinB = Number(oraclePriceRaw) / Number(PRICE_SCALE);
  return tokenIn === fx.tokenA ? priceAinB : 1 / priceAinB;
};

/** The on-chain quote of one route (fallback when local maths can't decide). */
async function simulateRoute(chain, base, tokenIn, amountIn, fx) {
  if (base.venue === "fx") {
    const r = await chain.tryRead(fx.id, "quote", sv.addr(tokenIn), sv.i128(amountIn));
    if (!r.ok) return { ...base, ok: false, error: r.error };
    const feeBps = Number(r.value.fee_bps);
    return finish({ ...base, ok: true, amountOut: BigInt(r.value.amount_out), mid: fxMid(fx, tokenIn, r.value.oracle_price), feeBps, feeFraction: feeBps / 10_000 }, amountIn);
  }
  const r = base.venue === "limeswap"
    ? await chain.tryRead(chain.config.router, "quote", sv.i128(amountIn), sv.addrs(base.tokens), sv.u32s(base.fees))
    : await chain.tryRead(chain.config.router, "quote_route", sv.i128(amountIn), sv.addrs(base.tokens), sv.hops(base.hops));
  if (!r.ok) return { ...base, ok: false, error: r.error };
  return quoted(base, r.value.map(BigInt), amountIn, fx);
}

// Price impact = how much worse than the mid price you get, *after* taking the fee out.
function finish(c, amountIn) {
  const ideal = Number(amountIn) * c.mid; // at mid price, no fee
  c.execPrice = ratio(c.amountOut, amountIn);
  c.priceImpact = ideal > 0 ? Math.max(0, 1 - Number(c.amountOut) / (ideal * (1 - c.feeFraction))) : NaN;
  return c;
}

function routeLabel(chain, { hops, tokens }) {
  const name = (h) => (h.type === "fx" ? "LimeFX (oracle-anchored)" : `LimeSwap ${h.feeBps / 100}%`);
  const symbol = (id) => {
    const key = Object.keys(chain.config.tokens).find((k) => chain.config.tokens[k] === id);
    return LABELS[key] ?? key ?? "?";
  };
  const via = hops.length > 1 ? ` (via ${tokens.slice(1, -1).map(symbol).join(", ")})` : "";
  return hops.map(name).join(" → ") + via;
}

/** min_out at a slippage tolerance in bps (e.g. 50 = 0.5%). */
export const minOut = (amountOut, slippageBps) => (BigInt(amountOut) * BigInt(10_000 - slippageBps)) / 10_000n;

/** Contract call for the chosen route: [contractId, method, args]. */
export function swapCall(chain, route, user, amountIn, minimum, now) {
  if (route.venue === "fx") {
    return [route.hops[0].id, "swap", [sv.addr(user), sv.addr(user), sv.addr(route.tokens[0]), sv.i128(amountIn), sv.i128(minimum)]];
  }
  const deadline = BigInt(now + 300); // 5 minutes
  if (route.venue === "mixed") {
    return [chain.config.router, "swap_route", [
      sv.addr(user), sv.addr(user), sv.i128(amountIn), sv.i128(minimum), sv.addrs(route.tokens), sv.hops(route.hops), sv.u64(deadline),
    ]];
  }
  return [chain.config.router, "swap_exact_in", [
    sv.addr(user), sv.addr(user), sv.i128(amountIn), sv.i128(minimum), sv.addrs(route.tokens), sv.u32s(route.fees), sv.u64(deadline),
  ]];
}

// ---------- Accounts, positions, compliance ----------

/**
 * Token (or LP share) balance; null if it couldn't be read (shown as "–", never as a fake 0).
 * XLM and classic tokens of a G-account come from its account/trustline entries (one batched
 * request per ledger, exactly what the SAC's balance() returns); everything else is simulated.
 */
export async function balanceOf(chain, tokenId, user) {
  const asset = chain.classic?.get(tokenId);
  if (asset && user.startsWith("G")) {
    try {
      const st = await accountState(chain, user, classicAssets(chain));
      if (!st.exists) return null; // the SAC fails for a missing account too
      if (asset === "native") return st.balance;
      if (asset.split(":")[1] === user) return I64_MAX; // the issuer has unlimited supply
      return st.lines.get(asset)?.balance ?? null; // no trustline: the SAC errors
    } catch (e) {
      console.warn(`batched balance read failed, simulating: ${e.message}`);
    }
  }
  const r = await chain.tryRead(tokenId, "balance", sv.addr(user));
  if (!r.ok) console.warn(`balance(${tokenId.slice(0, 6)}…) failed: ${r.raw ?? r.error}`);
  return r.ok ? BigInt(r.value) : null;
}
const I64_MAX = (1n << 63n) - 1n;

/**
 * Trustline status of `user` for a classic token: "authorized" | "frozen" | "missing" | "n/a".
 * From the batched trustline entries (AUTHORIZED flag), like the SAC's authorized(); falls back
 * to simulating authorized(), which errors (#13) when there is no trustline at all.
 */
export async function trustStatus(chain, token, user) {
  if (!token.classic || token.native) return "n/a";
  const asset = chain.classic?.get(token.id);
  if (asset && asset !== "native" && user.startsWith("G")) {
    try {
      const st = await accountState(chain, user, classicAssets(chain));
      if (st.exists) {
        if (asset.split(":")[1] === user) return "authorized";
        const line = st.lines.get(asset);
        return !line ? "missing" : line.flags & 1 ? "authorized" : "frozen";
      }
    } catch {}
  }
  const r = await chain.tryRead(token.id, "authorized", sv.addr(user));
  if (r.ok) return r.value ? "authorized" : "frozen";
  return /#13\b|trustline/i.test(r.raw ?? r.error) ? "missing" : "unknown";
}

/** User's LP position: shares, underlying amounts, owed (LimeSwap only). */
export async function position(chain, pool, user) {
  const shares = await balanceOf(chain, pool.id, user);
  const under = (r) => (shares === null ? null : pool.totalShares > 0n ? (shares * r) / pool.totalShares : 0n);
  let owed = [0n, 0n];
  if (pool.type === "limeswap") {
    const r = await chain.tryRead(pool.id, "owed", sv.addr(user));
    if (r.ok) owed = r.value.map(BigInt);
  }
  return { shares, amountA: under(pool.reserveA), amountB: under(pool.reserveB), owed, share: shares === null ? NaN : ratio(shares, pool.totalShares) };
}

/** Other side of a deposit at the pool ratio (same floor rounding as the contract). */
export function pairedAmount(pool, side, amount) {
  if (pool.totalShares === 0n || pool.reserveA === 0n || pool.reserveB === 0n) return null; // first deposit sets the price
  return side === "a" ? (amount * pool.reserveB) / pool.reserveA : (amount * pool.reserveA) / pool.reserveB;
}

/**
 * Deposit through router v2: the user signs transfers of exactly `a` and `b` (fixed amounts),
 * and the pool refunds whatever doesn't match its ratio. A direct `deposit` would sign amounts
 * computed from reserves, which fail if the reserves move before the transaction lands.
 */
export const depositCall = (chain, pool, user, a, b, slippageBps, now) => [chain.config.router, "add_liquidity_to", [
  sv.addr(user), sv.addr(pool.id), sv.addr(pool.tokenA), sv.addr(pool.tokenB), sv.i128(a), sv.i128(b),
  sv.i128(minOut(a, slippageBps)), sv.i128(minOut(b, slippageBps)), sv.u64(BigInt(now + 300)),
]];

export function withdrawCall(pool, user, shares, slippageBps = 100) {
  const a = (shares * pool.reserveA) / pool.totalShares, b = (shares * pool.reserveB) / pool.totalShares;
  return [pool.id, "withdraw", [sv.addr(user), sv.i128(shares), sv.i128(minOut(a, slippageBps)), sv.i128(minOut(b, slippageBps))]];
}

export const claimCall = (pool, user) => [pool.id, "claim", [sv.addr(user)]];

// ---------- Onboarding: test XLM, trustlines, faucet ----------

const assetNames = new Map();
/** "CODE:ISSUER" of a classic token's SAC (its `name()`), or null for XLM / contract tokens. */
export async function classicAsset(chain, token) {
  if (!token.classic || token.native) return null;
  if (!assetNames.has(token.id)) assetNames.set(token.id, await chain.read(token.id, "name"));
  return assetNames.get(token.id);
}

/**
 * What a visitor still needs before trading: account funded? which trustlines missing? faucet
 * claimable? Returns { funded, missing: [{token, asset}], faucet: {drips, nextClaim, now} | null }.
 */
export async function onboardingState(chain, tokens, user) {
  const funded = await chain.accountExists(user);
  const f = chain.config.faucet;
  const [drips, nextClaim, now] = f
    ? await Promise.all([chain.read(f, "drips"), chain.read(f, "next_claim", sv.addr(user)), chain.now()])
    : [[], 0, 0];
  const faucetTokens = drips.map((d) => tokens.find((t) => t.id === d.token)).filter(Boolean);
  const missing = [];
  if (funded) {
    for (const t of faucetTokens) {
      if ((await trustStatus(chain, t, user)) === "missing") missing.push({ token: t, asset: await classicAsset(chain, t) });
    }
  }
  return {
    funded,
    missing,
    faucet: f ? { id: f, drips: drips.map((d) => ({ token: d.token, amount: BigInt(d.amount) })), nextClaim: Number(nextClaim), now } : null,
  };
}

export const faucetClaimCall = (chain, user) => [chain.config.faucet, "claim", [sv.addr(user)]];

// ---------- Mock KYC (Testnet demo) ----------
// A regulated token (LFUND) can have a "KYC desk" contract as its SAC admin: one signature on
// `verify` creates the trustline, approves it and pays a starter grant. Real issuers would run a
// KYC check (SEP-12) or co-sign transfers (SEP-8) instead.

/** The KYC desk contract of `token`, or null. */
export const kycDesk = (chain, token) => chain.config.kyc?.[token?.key] ?? null;

const KYC_STATUS = ["unverified", "verified", "revoked"];
/** "unverified" | "verified" | "revoked" (frozen by the issuer), or null without a desk. */
export async function kycStatus(chain, token, user) {
  const desk = kycDesk(chain, token);
  if (!desk || !user) return null;
  const r = await chain.tryRead(desk, "status", sv.addr(user));
  return r.ok ? KYC_STATUS[Number(r.value)] ?? null : null;
}

/** Starter grant paid by `verify` (raw units), or 0n. */
export async function kycGrant(chain, token) {
  const desk = kycDesk(chain, token);
  if (!desk) return 0n;
  const r = await chain.tryRead(desk, "grant");
  return r.ok ? BigInt(r.value) : 0n;
}

export const kycVerifyCall = (chain, token, user) => [kycDesk(chain, token), "verify", [sv.addr(user)]];

// ---------- Your positions (Liquidity overview, pool badges) ----------

/**
 * Approximate USD price per whole token, walking the pool graph from LUSD ($1): each pool's
 * mid price (LimeFX: the oracle price) links its two tokens. Tokens no pool connects are absent.
 * For display only ("≈ $"); never used for amounts that go on-chain.
 */
export function usdPrices(pools, fx, tokens) {
  const lusd = tokens.find((t) => t.key === "lusd")?.id;
  const price = new Map(lusd ? [[lusd, 1]] : []);
  const links = [...pools.filter((p) => p.reserveA > 0n && p.reserveB > 0n), ...(fx?.oraclePrice ? [fx] : [])]
    .map((p) => ({ a: p.tokenA, b: p.tokenB, aInB: p.type === "fx" ? p.oraclePrice : p.mid }));
  for (let changed = true; changed; ) {
    changed = false;
    for (const { a, b, aInB } of links) {
      if (!aInB || !isFinite(aInB)) continue;
      if (price.has(b) && !price.has(a)) { price.set(a, aInB * price.get(b)); changed = true; }
      else if (price.has(a) && !price.has(b)) { price.set(b, price.get(a) / aInB); changed = true; }
    }
  }
  return price;
}

/**
 * The connected account's liquidity positions, from the `mine` field loadState puts on each
 * pool: [{ pool, shares, share, amountA, amountB, owed, usd }] for pools where it holds LP
 * shares or is owed tokens, biggest first; plus the total ≈ USD. Empty without an account.
 */
export function myPositions(pools, fx, tokens) {
  const prices = usdPrices(pools, fx, tokens);
  const units = (id, amount) => Number(amount) / 10 ** (tokens.find((t) => t.id === id)?.decimals ?? 7);
  const usdOf = (id, amount) => (prices.has(id) ? units(id, amount) * prices.get(id) : NaN);
  const list = [];
  for (const pool of [...(fx ? [fx] : []), ...pools]) {
    const mine = pool.mine;
    if (!mine || (mine.shares === 0n && mine.owed.every((x) => x === 0n))) continue;
    const under = (r) => (pool.totalShares > 0n ? (mine.shares * r) / pool.totalShares : 0n);
    const amountA = under(pool.reserveA), amountB = under(pool.reserveB);
    const usd = usdOf(pool.tokenA, amountA + mine.owed[0]) + usdOf(pool.tokenB, amountB + mine.owed[1]);
    list.push({ pool, shares: mine.shares, share: ratio(mine.shares, pool.totalShares), amountA, amountB, owed: mine.owed, usd });
  }
  list.sort((x, y) => (isNaN(y.usd) ? -1 : isNaN(x.usd) ? 1 : y.usd - x.usd));
  const priced = list.filter((p) => !isNaN(p.usd));
  return { positions: list, totalUsd: priced.reduce((s, p) => s + p.usd, 0), allPriced: priced.length === list.length };
}

// ---------- Fee tiers ----------

const TIER_NAMES = { 5: "Stable", 30: "Standard", 100: "High fee" };
/** "Standard · 0.30% fee" style label part for a LimeSwap pool's fee tier. */
export const tierName = (feeBps) => TIER_NAMES[feeBps] ?? "Custom";
/**
 * Plain-language explanation for a LimeSwap pool's fee tier: always when the same pair has
 * pools in other tiers (otherwise two "LIME / XLM" rows look like duplicates), plus the
 * deployment's note on why this particular pool exists. null when there's nothing to say.
 */
export function feeTierHelp(pool, pools, notes = {}) {
  if (pool.type === "fx") return null;
  const same = pools.filter((p) => p.type !== "fx" && p.id !== pool.id
    && ((p.tokenA === pool.tokenA && p.tokenB === pool.tokenB) || (p.tokenA === pool.tokenB && p.tokenB === pool.tokenA)));
  const parts = [];
  if (same.length) {
    const others = same.map((p) => `${(p.feeBps / 100).toFixed(2)}%`).join(", ");
    parts.push(`Fee tiers: this pair also has a pool at ${others}. Each tier is a separate pool. Liquidity providers choose: a low fee wins more trades, a high fee earns more per trade but trades less. Swaps always go through whichever pool gives you the best price after fees.`);
  }
  if (notes[pool.id]) parts.push(notes[pool.id]);
  return parts.length ? parts.join(" ") : null;
}
