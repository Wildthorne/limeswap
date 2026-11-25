// LP fee earnings on the Pools and Liquidity tabs. The maths lives in src/fees.js; this module
// loads the pool event history in the background (Pools/Liquidity only, at most every 20 s,
// incremental thanks to a localStorage cache) and turns the results into small HTML pieces.
import { tokenById, usdPrices } from "../dex.js";
import { loadHistory, poolEarnings, poolsAt, priceEarnings, WINDOW_DAYS } from "../fees.js";
import { esc } from "../format.js";
import { tip } from "./dom.js";

const EVERY_MS = 20_000;
let app;
let busy = false, at = 0;
let stale = false; // invalidated while a load was running: run again at the next chance
let history = null;
let failed = null;
const results = new Map(); // pool id → { e: poolEarnings, v: priceEarnings }

export function init(a) {
  app = a;
}

/** Fetch again on the next chance (after our own transaction, or a new wallet). */
export function invalidate() {
  at = 0;
  stale = true;
}

const cacheFor = (chain) => {
  const key = `limeswap:events:${chain.config.passphrase}`;
  return {
    get: () => { try { return localStorage.getItem(key); } catch { return null; } },
    set: (v) => { try { localStorage.setItem(key, v); } catch { /* full or blocked */ } },
  };
};

/** Load new pool events if due, then recompute. `visible` = Pools or Liquidity is showing. */
export async function refreshIfDue(visible) {
  if (!app || !visible || busy || !app.pools.length || Date.now() - at < EVERY_MS) return;
  busy = true;
  stale = false;
  try {
    // Read the events up to the ledger the pool state on screen comes from, and compute with
    // exactly that state (later refreshes may replace app.pools meanwhile).
    const snap = { pools: allPools(), ledger: app.ledger };
    const ids = snap.pools.map((p) => p.id);
    // RPC's event index can trail its ledger data by a moment: catch up (only new ledgers).
    for (let i = 0; i < 3; i++) {
      history = await loadHistory(app.chain.server, ids, { cache: cacheFor(app.chain), upTo: snap.ledger });
      if (compute(snap)) break;
      await new Promise((r) => setTimeout(r, 1500));
    }
    failed = null;
    // Your position needs the pool state with your account in it; if that wasn't there yet
    // (first visit, a wallet that just connected), compute again with the next state read.
    const noAccount = app.signer && snap.pools.every((p) => p.mine === undefined);
    at = stale || noAccount ? 0 : Date.now();
    app.changed();
  } catch (e) {
    failed = e?.message ?? String(e);
    at = Date.now(); // try again later, not on every ledger
    app.changed();
  } finally {
    busy = false;
    // Asked to run again meanwhile, and the state on screen now has what was missing: go now,
    // not at the next ledger (or 20 s later).
    if (at === 0 && !(app.signer && allPools().every((p) => p.mine === undefined))) setTimeout(() => refreshIfDue(visible), 0);
  }
}

const allPools = () => [...(app.fx ? [app.fx] : []), ...app.pools];

/**
 * Recompute every pool from the history and a snapshot of the pool state. Only when the history
 * reaches the ledger that state was read at; otherwise the newest swaps would be missing from
 * the rebuild, so we keep the previous numbers until the next fetch.
 */
function compute({ pools, ledger }) {
  if (!history || history.toLedger - 1 < ledger) return false;
  const prices = usdPrices(app.pools, app.fx, app.tokens);
  const usd = (id, raw) => (prices.has(id) ? (Number(raw) / 10 ** tokenById(app.tokens, id).decimals) * prices.get(id) : NaN);
  const user = app.signer?.address ?? null;
  // Token prices at an earlier moment (a position's start): every pool rebuilt to that time,
  // priced the same way as now (usdPrices: LUSD = $1, walking the pool graph). One per moment.
  const cp = pools.filter((p) => p.type !== "fx"), fx = pools.find((p) => p.type === "fx") ?? null;
  const thenCache = new Map();
  const usdAt = (t) => {
    if (!thenCache.has(t)) {
      const then = poolsAt(cp, fx, history, t, ledger);
      const pr = usdPrices(then.pools, then.fx, app.tokens);
      thenCache.set(t, (id, raw) => (pr.has(id) ? (Number(raw) / 10 ** tokenById(app.tokens, id).decimals) * pr.get(id) : NaN));
    }
    return thenCache.get(t);
  };
  results.clear();
  for (const p of pools) {
    const e = poolEarnings(p, history, { user, shares: p.mine?.shares ?? 0n, atLedger: ledger });
    const v = priceEarnings(p, e, usd);
    if (v?.user) {
      const then = usdAt(e.user.since);
      v.user.entryUsd = then(p.tokenA, e.user.startA) + then(p.tokenB, e.user.startB);
      v.user.entryAt = e.user.since;
      v.user.entryKnown = e.user.known;
    }
    results.set(p.id, { e, v });
  }
  return true;
}

// ---------- Formatting ----------

// Testnet fees are often fractions of a cent: show those with 4 decimals rather than "$0.00".
const money = (x) => {
  if (!Number.isFinite(x)) return "–";
  const a = Math.abs(x);
  if (a === 0) return "$0";
  if (a < 0.0001) return "< $0.0001";
  return `$${a.toLocaleString("en-US", a < 0.01 ? { minimumFractionDigits: 4, maximumFractionDigits: 4 } : { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};
const signed = (x) => (!Number.isFinite(x) ? "–" : Math.abs(x) < 0.0001 ? "$0" : `${x > 0 ? "+" : "−"}${money(x)}`);
const pct = (x) => (x >= 10 ? `${Math.round(x * 100).toLocaleString("en-US")}%` : `${(x * 100).toFixed(x < 0.001 ? 3 : 2)}%`);
const day = (s) => new Date(s * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const period = (days) => (days >= WINDOW_DAYS - 0.01 ? `last ${WINDOW_DAYS} days` : days >= 1 ? `last ${days.toFixed(1)} days` : `last ${Math.max(1, Math.round(days * 24))} h`);

const APR_HELP = "Swap fees the pool collected recently, divided by what the pool holds now, scaled to a year. Every fee stays in the pool for its LPs (LimeSwap takes no cut). It's an estimate from recent trading: on Testnet that's mostly bots and tests, so it jumps around. It leaves out price moves, which can cost LPs more than the fees earn.";

/** "≈ 12.4% APR" tag for a pool row (nothing until a day of history exists). */
export function aprTag(pool) {
  const r = results.get(pool.id);
  if (!r?.v || r.v.apr === null || !Number.isFinite(r.v.apr)) return "";
  return `<span class="tag" title="Fee APR from the ${esc(period(r.e.days))}: fees ÷ pool value, annualised">≈ ${pct(r.v.apr)} APR</span>`;
}

/** <dt>/<dd> rows for a pool's details: fees over the window and 24 h, fee APR. */
export function poolFeeRows(pool) {
  const r = results.get(pool.id);
  if (!r) {
    const note = failed ? `<small>couldn't load: ${esc(failed)}</small>` : `<span class="sk" style="height:14px;width:60%" aria-label="Loading"></span>`;
    return `<dt>Fees to LPs</dt><dd>${note}</dd>`;
  }
  if (!r.e) return `<dt>Fees to LPs</dt><dd>–<small>no liquidity in the last ${WINDOW_DAYS} days</small></dd>`;
  const { e, v } = r;
  return `<dt>Fees to LPs ${tip(`Every swap pays the fee into the pool, so it belongs to the LPs in proportion to their shares. Counted from the pools' own swap events (Stellar RPC keeps about ${WINDOW_DAYS} days of them).`)}</dt>
    <dd>${money(v.feesUsd)} <small>${esc(period(e.days))} · ${e.swaps} swap${e.swaps === 1 ? "" : "s"}${e.days >= 1.5 ? ` · last 24 h ${money(v.fees24Usd)}` : ""}</small></dd>
    <dt>Fee APR ${tip(APR_HELP)}</dt>
    <dd>${v.apr === null || !Number.isFinite(v.apr) ? `–<small>needs a day of history</small>` : `≈ ${pct(v.apr)}<small>from the ${esc(period(e.days))}</small>`}</dd>`;
}

/**
 * Two labelled numbers under a position (design, Nov 6): "Fees earned" and "vs holding". The price-move
 * part and the start date go in the hover text (the row is a button, so no nested "?" there).
 */
export function positionStats(pool) {
  const r = results.get(pool.id);
  if (!r) return failed ? "" : `<span class="pos-stats"><span class="stat-mini"><span class="k">Fees earned</span><span class="sk" style="height:14px;width:56px"></span></span></span>`;
  const u = r.v?.user;
  if (!u) return "";
  const since = day(r.e.user.since);
  const title = `Since ${since}, at today's prices. Fees: your share of every swap fee, ${signed(u.feesUsd)}. Price moves: what the pool's rebalancing cost you compared with holding the two tokens yourself ("impermanent loss"), ${signed(u.priceUsd)}. Together: ${signed(u.vsHoldUsd)} vs just holding.`;
  const cls = (x) => (x >= 0.0001 ? "up" : x <= -0.0001 ? "down" : "");
  return `<span class="pos-stats" title="${esc(title)}">
    <span class="stat-mini"><span class="k">Fees earned</span><b class="${cls(u.feesUsd)}">${signed(u.feesUsd)}</b></span>
    <span class="stat-mini"><span class="k">vs holding</span><b class="${cls(u.vsHoldUsd)}">${signed(u.vsHoldUsd)}</b></span>
  </span>`;
}

/**
 * A position's numbers for a plain profit/loss line (USD, numbers not strings):
 * undefined while the history loads, null if it failed or there's no position, otherwise
 * { feesUsd, nowUsd, holdUsd, vsHoldUsd, priceUsd,   // at today's prices (see priceEarnings)
 *   entryUsd,    // what the position held at its start, at that moment's prices
 *   entryAt,     // that start (unix s)
 *   entryKnown } // true: your own deposit / withdrawal / LP transfer; false: just where our
 *                // ~7-day history starts (your deposit is older)
 */
export function positionNumbers(pool) {
  const r = results.get(pool.id);
  if (!r) return failed ? null : undefined;
  const u = r.v?.user;
  return u ? { ...u } : null;
}

/** Explainer for the "?" next to "Your positions" (was a caption under the list). */
export const POSITIONS_HELP = `Fees earned = your share of every swap fee. vs holding = fees plus the effect of price moves, compared with simply holding the two tokens ("impermanent loss"). Counted since your last deposit or withdrawal, at most ${WINDOW_DAYS} days back (Stellar RPC keeps about ${WINDOW_DAYS} days of events), at today's prices. Hover a position for its breakdown.`;
