// Exact local quotes (BigInt, floor division), bit-for-bit what the contracts compute, so the app
// can price every candidate route without a simulation per route.
// Every function returns null where the contract would revert (or where we can't be sure it
// wouldn't): the caller then simulates that route instead, which also yields the real error.
// Ports of: lime-amm/contracts/router (amount_out), contracts/fx-pool (curve_out, price_swap,
// add_flow); same maths as lime-arb/math.mjs, which matches the chain to the unit.

const BPS = 10_000n;
const I128_MAX = (1n << 127n) - 1n;

/** LimeSwap constant product: out = in·(1−f)·R_out / (R_in + in·(1−f)), 256-bit, floor. */
export function cpOut(amountIn, reserveIn, reserveOut, feeBps) {
  // The router panics (InsufficientOutput) on a zero input or an empty side.
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return null;
  const inWithFee = (amountIn * (BPS - BigInt(feeBps))) / BPS;
  const out = (inWithFee * reserveOut) / (reserveIn + inWithFee);
  return out > I128_MAX ? null : out;
}

/**
 * LimeFX curve_out (I256 in Rust): constant product on virtual reserves.
 *   X = 2·r_in·p_in + V,  Y = 2·r_out·p_out + V,  V = amp·(r_in·p_in + r_out·p_out)
 *   out = floor(Y·din / ((X + din)·2·p_out)),  din = 2·amount_in·p_in
 * Homogeneous in (p_in, p_out): only their ratio matters, exactly.
 */
export function fxCurveOut(amountIn, rIn, rOut, pIn, pOut, amp) {
  if (amountIn <= 0n) return 0n;
  const wIn = rIn * pIn;
  const wOut = rOut * pOut;
  const v = BigInt(amp) * (wIn + wOut);
  const x = 2n * wIn + v;
  const y = 2n * wOut + v;
  const din = 2n * amountIn * pIn;
  return (y * din) / ((x + din) * 2n * pOut);
}

/** Would this swap push the window's net outflow over the cap (FxPoolError #24)? Mirrors add_flow. */
function overCap(w, cap, aIn, amountIn, out, rOut) {
  const netOut = aIn ? w.netOutB + out : w.netOutA + out;
  const base = aIn ? w.baseB : w.baseA;
  const allowed = ((base < rOut ? base : rOut) * BigInt(cap.capBps)) / BPS;
  return netOut > allowed;
}

/**
 * LimeFX exact-input quote with the fee and oracle price of this refresh (`fx.feeBps`,
 * `fx.oraclePriceRaw`). null = simulate instead: no exact oracle substitute, the oracle check
 * failed, paused, the pool can't pay, or the outflow cap (v3, #24) might be hit.
 */
export function fxOut(fx, tokenIn, amountIn) {
  if (!fx?.exact || fx.paused || fx.feeBps === undefined || amountIn <= 0n) return null;
  const aIn = tokenIn === fx.tokenA;
  if (!aIn && tokenIn !== fx.tokenB) return null;
  const { reserveA: ra, reserveB: rb } = fx;
  if (ra <= 0n || rb <= 0n) return null;
  // pA/pB = oracle_price / 10^14 exactly when asset_b is the oracle base (see loadState).
  const pA = fx.oraclePriceRaw, pB = fx.priceScale;
  const netIn = (amountIn * (BPS - BigInt(fx.feeBps))) / BPS;
  const out = aIn ? fxCurveOut(netIn, ra, rb, pA, pB, fx.amp) : fxCurveOut(netIn, rb, ra, pB, pA, fx.amp);
  const rOut = aIn ? rb : ra;
  if (out >= rOut || out > I128_MAX) return null; // InsufficientLiquidity
  // The outflow window depends on the ledger time the swap lands in: check both the stored
  // window and a fresh one; if either would trip the cap, let the contract decide.
  const fresh = { baseA: ra, baseB: rb, netOutA: 0n, netOutB: 0n };
  if (fx.flow && overCap(fx.flow, fx.outflowCap, aIn, amountIn, out, rOut)) return null;
  if (overCap(fresh, fx.outflowCap, aIn, amountIn, out, rOut)) return null;
  return out;
}

/**
 * Amounts along a route ([amount_in, after hop 1, …]) computed locally, or null if any hop
 * needs the chain. hops: LimeSwap pool objects or the LimeFX object; tokens: [in, …, out].
 */
export function routeAmounts(hops, tokens, amountIn) {
  const amounts = [amountIn];
  for (let i = 0; i < hops.length; i++) {
    const h = hops[i], tIn = tokens[i], x = amounts[i];
    let out;
    if (h.type === "fx") {
      out = fxOut(h, tIn, x);
    } else {
      const aIn = tIn === h.tokenA;
      out = aIn ? cpOut(x, h.reserveA, h.reserveB, h.feeBps) : cpOut(x, h.reserveB, h.reserveA, h.feeBps);
    }
    if (out === null) return null;
    amounts.push(out);
  }
  return amounts;
}
