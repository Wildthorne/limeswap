// LP fee earnings from the pools' own events (no indexer). Every swap's fee stays in the pool, so
// an LP earns fee × (their shares / all shares at that moment). We read the last ~7 days of pool
// events from RPC (its retention window), rebuild each pool's reserves and LP supply backwards
// from the state on screen, and compare an LP position with simply holding the same tokens.
// DOM-free: shared with test-fees.mjs and verify-fees.mjs.
import { scValToNative } from "@stellar/stellar-sdk";

export const WINDOW_DAYS = 7;
const DAY = 86_400;
const BPS = 10_000n;
// Public RPC scans about this many ledgers per getEvents call, so ask for ranges of this size.
const LEDGERS_PER_REQUEST = 10_000;
// getEvents takes up to 5 filters with up to 5 contract IDs each.
const IDS_PER_FILTER = 5;
const IDS_PER_REQUEST = 25;
const PAGE = 10_000;
// A first visit reads ~13 ranges; public RPC answers them all at once in ~5 s (in fours: ~20 s,
// since some calls wait ~5 s server-side whatever their size). Later visits read only new ledgers.
const CONCURRENCY = 16;
// Entry values use this TWAP window, like the Pools tab's "10-min average".
const TWAP_SEC = 600;
// Stay this many ledgers (≈ 5 min) inside RPC's retention window.
const EDGE_LEDGERS = 60;
// Pool events that move reserves or LP shares; the rest (admin, upgrades…) don't matter here.
const KEEP = new Set(["swap", "deposit", "withdraw", "sync", "mint", "burn", "transfer", "force_redeem"]);

/** Fee charged on an input amount: the contracts take it from the input and round the rest down. */
export const feeOf = (amountIn, feeBps) => (amountIn > 0n ? amountIn - (amountIn * (BPS - BigInt(feeBps))) / BPS : 0n);

/** RPC event → { id, ledger, at (unix s), tx, contract, name, topics, data } with bigints. */
export function decodeEvent(e) {
  return {
    id: e.id,
    ledger: e.ledger,
    at: Math.floor(Date.parse(e.ledgerClosedAt) / 1000),
    tx: e.txHash,
    contract: typeof e.contractId === "string" ? e.contractId : e.contractId.contractId(),
    name: scValToNative(e.topic[0]),
    topics: e.topic.slice(1).map(scValToNative),
    data: scValToNative(e.value),
  };
}

const cursorLedger = (cursor) => Number(BigInt(String(cursor).split("-")[0]) >> 32n);

/**
 * Every kept event of `ids` with from ≤ ledger < to, oldest first, and the newest ledger RPC had
 * indexed (`latestLedger`): { events, latestLedger }. The range is split into
 * LEDGERS_PER_REQUEST chunks fetched up to `concurrency` at a time; a full page continues by cursor.
 */
export async function fetchEvents(server, ids, from, to, { concurrency = CONCURRENCY } = {}) {
  const jobs = [];
  for (let i = 0; i < ids.length; i += IDS_PER_REQUEST) {
    const group = ids.slice(i, i + IDS_PER_REQUEST);
    const filters = [];
    for (let j = 0; j < group.length; j += IDS_PER_FILTER) filters.push({ type: "contract", contractIds: group.slice(j, j + IDS_PER_FILTER) });
    for (let a = from; a < to; a += LEDGERS_PER_REQUEST) jobs.push({ filters, a, b: Math.min(a + LEDGERS_PER_REQUEST, to) });
  }
  const found = new Map();
  let latestLedger = 0;
  const run = async ({ filters, a, b }) => {
    let r = await server.getEvents({ startLedger: a, endLedger: b, filters, limit: PAGE });
    for (;;) {
      latestLedger = Math.max(latestLedger, r.latestLedger ?? 0);
      for (const e of r.events) {
        if (e.ledger < a || e.ledger >= b) continue;
        const ev = decodeEvent(e);
        if (KEEP.has(ev.name)) found.set(ev.id, ev);
      }
      // Done when the scan reached the end of the range (or stopped moving).
      const at = r.cursor ? cursorLedger(r.cursor) : b;
      if (at >= b - 1 || (!r.events.length && !r.cursor)) break;
      const next = await server.getEvents({ cursor: r.cursor, filters, limit: PAGE });
      if (next.cursor === r.cursor) break;
      r = next;
    }
  };
  for (let i = 0; i < jobs.length; i += concurrency) await Promise.all(jobs.slice(i, i + concurrency).map(run));
  return { events: [...found.values()].sort(byId), latestLedger };
}

const byId = (x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);

// Cache rows keep bigints as {"$b": "…"} so they survive JSON.
const toJson = (v) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? { $b: x.toString() } : x));
const fromJson = (s) => JSON.parse(s, (_, x) => (x && typeof x === "object" && "$b" in x ? BigInt(x.$b) : x));

/**
 * Pool events for the whole RPC retention window (≈ 7.7 days on public Testnet), incremental:
 * `cache` ({ get(): string|null, set(string) }) keeps what was already read, so later calls only
 * ask for ledgers since the last one. Events are immutable, so the cache never goes stale; it's
 * dropped when the pool list changes or the ledger numbers go backwards (network reset).
 * `upTo`: read through this ledger (the one the pool state on screen was read at). With a cache
 * that skips getHealth, which public RPC sometimes answers only after seconds; the retention
 * window is then the one remembered from the last getHealth.
 * Returns { events, fromLedger, fromAt, toLedger, toAt }: complete for fromLedger ≤ ledger < toLedger.
 */
export async function loadHistory(server, ids, { cache = null, concurrency = CONCURRENCY, upTo = null } = {}) {
  const key = [...ids].sort().join(",");
  let c = null;
  try { c = cache?.get() ? fromJson(cache.get()) : null; } catch { c = null; }
  if (c && (c.key !== key || (upTo !== null && c.toLedger > upTo + 1) || !c.perLedger)) c = null;
  if (!c || upTo === null) {
    const h = await server.getHealth();
    const span = Math.max(1, h.latestLedger - h.oldestLedger);
    const perLedger = (Number(h.latestLedgerCloseTime) - Number(h.oldestLedgerCloseTime)) / span;
    const base = { window: span, perLedger, top: h.latestLedger, topAt: Number(h.latestLedgerCloseTime) };
    // A cache from before a network reset (ledger numbers went backwards) or older than the window.
    if (c && (c.toLedger > h.latestLedger + 1 || c.toLedger < h.oldestLedger)) c = null;
    c = c ? { ...c, ...base } : { key, events: [], toLedger: null, ...base };
  } else {
    // Move the remembered clock forward to `upTo`.
    c.topAt = c.topAt + (upTo - c.top) * c.perLedger;
    c.top = upTo;
  }
  const top = upTo ?? c.top;
  // The oldest ledger keeps moving forward (by the time our request lands it may be gone), so
  // start a little inside the window.
  const oldest = Math.min(top - c.window + EDGE_LEDGERS, top);
  const oldestAt = Math.round(c.topAt - (top - oldest) * c.perLedger);
  const from = Math.max(c.toLedger ?? oldest, oldest);
  const got = await fetchEvents(server, ids, from, top + 1, { concurrency });
  // RPC may not have indexed the newest ledger yet: then only claim what it had.
  const toLedger = Math.max(from, Math.min(top, got.latestLedger || top) + 1);
  const seen = new Set(c.events.map((e) => e.id));
  const events = [...c.events.filter((e) => e.ledger >= oldest), ...got.events.filter((e) => !seen.has(e.id) && e.ledger < toLedger)].sort(byId);
  const out = { key, fromLedger: oldest, fromAt: oldestAt, toLedger, toAt: Math.round(c.topAt), events };
  try { cache?.set(toJson({ ...out, window: c.window, perLedger: c.perLedger, top: c.top, topAt: c.topAt })); } catch { /* storage full or blocked: works without */ }
  return out;
}

/**
 * One pool's transactions with the pool state before and after each, rebuilt backwards from the
 * current state `now` = { reserveA, reserveB, totalShares } (as read at ledger ≤ `atLedger`).
 * LimeSwap pools also publish `sync` (exact reserves after each change): where present it is
 * used as the truth, and `mismatches` counts the times our own sums disagreed with it.
 */
export function poolTxs(pool, events, atLedger = Infinity) {
  const txs = [];
  for (const e of events) {
    if (e.contract !== pool.id || e.ledger > atLedger) continue;
    let t = txs.at(-1);
    if (!t || t.tx !== e.tx) txs.push((t = { tx: e.tx, at: e.at, ledger: e.ledger, dA: 0n, dB: 0n, dS: 0n, swaps: [], sync: null, moved: new Set(), mintS: null, burnS: null, depS: 0n, wdS: 0n }));
    const d = e.data, [t0, t1] = e.topics;
    switch (e.name) {
      case "swap": {
        t.dA += d.in_a - d.out_a;
        t.dB += d.in_b - d.out_b;
        // LimeFX's fee is dynamic and travels with the event; LimeSwap's is the pool's tier.
        t.swaps.push({ inA: d.in_a, inB: d.in_b, outA: d.out_a, outB: d.out_b, feeBps: d.fee_bps ?? pool.feeBps });
        break;
      }
      case "deposit": t.dA += d.amount_a; t.dB += d.amount_b; t.depS += d.shares; t.moved.add(t0); break;
      case "withdraw": t.dA -= d.amount_a; t.dB -= d.amount_b; t.wdS += d.shares; t.moved.add(t0); break;
      case "force_redeem": { // compliance pools: the holder's regulated side goes to the issuer, the other side to the holder
        const regIsA = t1 === pool.tokenA;
        t.dA -= regIsA ? d.seized : d.other;
        t.dB -= regIsA ? d.other : d.seized;
        break;
      }
      case "sync": t.sync = { a: d.reserve_a, b: d.reserve_b }; break;
      case "mint": t.mintS = (t.mintS ?? 0n) + d.amount; t.moved.add(t0); break;
      case "burn": t.burnS = (t.burnS ?? 0n) + d.amount; t.moved.add(t0); break;
      case "transfer": t.moved.add(t0).add(t1); break;
    }
  }
  // LP supply: the token's mint/burn events, or else the deposit/withdraw `shares` (LimeFX
  // before v4 burned on withdraw without a burn event; keep this while such withdrawals are
  // still inside RPC's ~7-day window).
  for (const t of txs) t.dS = (t.mintS ?? t.depS) - (t.burnS ?? t.wdS);
  let st = { a: pool.reserveA, b: pool.reserveB, s: pool.totalShares };
  let mismatches = 0;
  for (let i = txs.length - 1; i >= 0; i--) {
    const t = txs[i];
    const post = { ...st };
    if (t.sync) {
      if (t.sync.a !== post.a || t.sync.b !== post.b) mismatches++;
      post.a = t.sync.a;
      post.b = t.sync.b;
    }
    t.post = post;
    t.pre = { a: post.a - t.dA, b: post.b - t.dB, s: post.s - t.dS };
    st = t.pre;
  }
  return { txs, mismatches };
}

/**
 * Fee earnings of one pool over the last `windowDays` (or since the pool or your position
 * started, if later), as raw token amounts.
 * - Pool: fees and volume per token, last 24 h too, the period actually covered (`since`, `days`).
 * - `user` (with `shares` = their LP shares now): counted from the later of the window start and
 *   their last LP change (deposit, withdraw, transfer), so their shares were constant since:
 *   fees = Σ fee × shares / supply at each swap; `startA/B` = what their shares held then;
 *   `nowA/B` = what they hold now.
 */
export function poolEarnings(pool, history, { now = Math.floor(Date.now() / 1000), windowDays = WINDOW_DAYS, user = null, shares = 0n, atLedger = Infinity } = {}) {
  const { txs, mismatches } = poolTxs(pool, history.events, atLedger);
  const windowStart = Math.max(now - windowDays * DAY, history.fromAt);
  const first = txs.findIndex((t) => t.at > windowStart);
  let start = first < 0 ? { a: pool.reserveA, b: pool.reserveB, s: pool.totalShares } : txs[first].pre;
  let since = windowStart;
  let from = first < 0 ? txs.length : first;
  let scan = from; // where a user's own LP change can be found
  // A pool created inside the window starts with its first deposit.
  if (start.s === 0n) {
    const born = txs.findIndex((t, i) => i >= from && t.post.s > 0n);
    if (born < 0) return null; // never had liquidity in the window
    since = txs[born].at;
    start = txs[born].post;
    from = born + 1;
    scan = born; // the creator's own deposit counts as their entry
  }
  const r = {
    since, days: Math.max(0, now - since) / DAY, swaps: 0, mismatches,
    feesA: 0n, feesB: 0n, fees24A: 0n, fees24B: 0n, volumeA: 0n, volumeB: 0n,
    start, user: null,
  };
  // `known`: the period starts at the user's own deposit / withdrawal / LP transfer inside the
  // RPC window; otherwise it's just where our history starts (their position is older).
  let uSince = since, uStart = start, uFrom = from, known = false;
  if (user) {
    for (let i = txs.length - 1; i >= scan; i--) {
      if (txs[i].moved.has(user)) { uSince = txs[i].at; uStart = txs[i].post; uFrom = i + 1; known = true; break; }
    }
  }
  const u = user && shares > 0n ? { since: uSince, known, feesA: 0n, feesB: 0n } : null;
  for (let i = from; i < txs.length; i++) {
    const t = txs[i];
    for (const s of t.swaps) {
      const fa = feeOf(s.inA, s.feeBps), fb = feeOf(s.inB, s.feeBps);
      r.swaps++;
      r.feesA += fa; r.feesB += fb;
      r.volumeA += s.inA; r.volumeB += s.inB;
      if (t.at > now - DAY) { r.fees24A += fa; r.fees24B += fb; }
      if (u && i >= uFrom && t.pre.s > 0n) {
        u.feesA += (fa * shares) / t.pre.s;
        u.feesB += (fb * shares) / t.pre.s;
      }
    }
  }
  if (u) {
    u.startA = uStart.s > 0n ? (shares * uStart.a) / uStart.s : 0n;
    u.startB = uStart.s > 0n ? (shares * uStart.b) / uStart.s : 0n;
    u.nowA = pool.totalShares > 0n ? (shares * pool.reserveA) / pool.totalShares : 0n;
    u.nowB = pool.totalShares > 0n ? (shares * pool.reserveB) / pool.totalShares : 0n;
    u.days = Math.max(0, now - uSince) / DAY;
    r.user = u;
  }
  return r;
}

/** A pool's reserves and LP supply at unix time `t`: after every transaction up to `t`. */
export function stateAt(pool, txs, t) {
  let st = null;
  for (const x of txs) {
    if (x.at <= t) st = x.post;
    else { st ??= x.pre; break; }
  }
  return st ?? { a: pool.reserveA, b: pool.reserveB, s: pool.totalShares };
}

/**
 * Time-weighted average price (B per A, a number) of a LimeSwap pool over the `sec` seconds
 * before `t`, from the rebuilt timeline. A single trade (even your own, a moment before you
 * deposit) can't set it, which a spot price can. NaN if the pool had no liquidity then.
 */
export function twapAt(pool, txs, t, sec = TWAP_SEC) {
  let st = stateAt(pool, txs, t - sec), from = t - sec, sum = 0, span = 0;
  const add = (to) => {
    if (st.a > 0n && st.b > 0n && to > from) { sum += (Number(st.b) / Number(st.a)) * (to - from); span += to - from; }
  };
  for (const x of txs) {
    if (x.at <= t - sec) continue;
    if (x.at > t) break;
    add(x.at);
    st = x.post;
    from = x.at;
  }
  add(t);
  if (span > 0) return sum / span;
  return st.a > 0n ? Number(st.b) / Number(st.a) : NaN; // only changed exactly at `t`
}

/**
 * LimeFX's oracle price (A in B, a number) around time `t`, from the `oracle_price` its swap
 * events carry: the last swap at or before `t`, else the first one after. null if it never
 * traded in the history (its reserve ratio is not its price: the curve is anchored to the oracle).
 */
export function fxPriceAt(fx, events, t, priceScale) {
  let before = null, after = null;
  for (const e of events) {
    if (e.contract !== fx.id || e.name !== "swap" || e.data.oracle_price === undefined) continue;
    if (e.at <= t) before = e;
    else if (!after) after = e;
  }
  const e = before ?? after;
  return e ? Number(e.data.oracle_price) / Number(priceScale) : null;
}

/**
 * The pools as they were at unix time `t`, shaped like loadState's (reserves; LimeFX with
 * `oraclePrice`), so dex.usdPrices() can price tokens at that moment the way it does now.
 * `mid` is each LimeSwap pool's 10-minute TWAP up to `t` (twapAt), not its spot price: the
 * value of what someone deposited shouldn't depend on a trade seconds earlier (on Testnet a
 * 1,000 XLM swap moved the LIME/XLM 0.3% pool 4× just before a deposit). LimeFX's price is
 * the oracle price its swap events carry (fxPriceAt), already hard to move; without one it's
 * left out and LEUR is priced through the LEUR/LUSD LimeSwap pool instead.
 */
export function poolsAt(pools, fx, history, t, atLedger = Infinity) {
  const then = pools.map((p) => {
    const txs = poolTxs(p, history.events, atLedger).txs;
    const st = stateAt(p, txs, t);
    return { ...p, reserveA: st.a, reserveB: st.b, totalShares: st.s, mid: twapAt(p, txs, t) };
  });
  let fxThen = null;
  if (fx) {
    const st = stateAt(fx, poolTxs(fx, history.events, atLedger).txs, t);
    const price = fxPriceAt(fx, history.events, t, fx.priceScale ?? 100_000_000_000_000n);
    fxThen = { ...fx, reserveA: st.a, reserveB: st.b, totalShares: st.s, oraclePrice: price };
  }
  return { pools: then, fx: fxThen };
}

/**
 * Put prices on poolEarnings(): `usd(tokenId, rawAmount)` → dollars (NaN if unpriced).
 * - feesUsd / fees24Usd / tvlUsd, and apr = fees ÷ TVL, annualised over the days covered
 *   (null under a day: too little to extrapolate).
 * - user: feesUsd, nowUsd (position now), holdUsd (the tokens it held at the start, at today's
 *   prices), vsHoldUsd = now − hold, priceUsd = vsHold − fees (the effect of price moves,
 *   "impermanent loss" for a plain x·y=k pool).
 */
export function priceEarnings(pool, e, usd) {
  if (!e) return null;
  const two = (a, b) => usd(pool.tokenA, a) + usd(pool.tokenB, b);
  const feesUsd = two(e.feesA, e.feesB);
  const tvlUsd = two(pool.reserveA, pool.reserveB);
  const out = {
    feesUsd, fees24Usd: two(e.fees24A, e.fees24B), tvlUsd,
    apr: e.days >= 1 && tvlUsd > 0 ? (feesUsd / tvlUsd) * (365 / e.days) : null,
    user: null,
  };
  if (e.user) {
    const u = e.user;
    const fees = two(u.feesA, u.feesB), now = two(u.nowA, u.nowB), hold = two(u.startA, u.startB);
    out.user = { feesUsd: fees, nowUsd: now, holdUsd: hold, vsHoldUsd: now - hold, priceUsd: now - hold - fees };
  }
  return out;
}
