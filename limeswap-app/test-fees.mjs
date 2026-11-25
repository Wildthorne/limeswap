// Unit tests for src/fees.js (LP fee earnings) with synthetic pool histories and a fake RPC server.
// No network. Run: npm run test:fees
import assert from "node:assert/strict";
import { cpOut } from "./src/quote.js";
import { feeOf, fetchEvents, fxPriceAt, loadHistory, poolEarnings, poolsAt, poolTxs, priceEarnings, stateAt, twapAt } from "./src/fees.js";

const DAY = 86_400;
const NOW = 1_800_000_000;
const A = "CTOKENA", B = "CTOKENB", P = "CPOOL", FX = "CFX";
const ME = "GME", YOU = "GYOU";

/**
 * A tiny x·y=k pool simulator that emits the same events as the contract (mint, sync, deposit,
 * swap, burn, withdraw, transfer), so the tests know the true state at every step.
 */
function simPool(id = P, feeBps = 30) {
  const st = { a: 0n, b: 0n, s: 0n, bal: new Map() };
  const events = [];
  let ledger = 1000, n = 0;
  const emit = (tx, at, name, topics, data) => events.push({ id: `${String(ledger).padStart(10, "0")}-${String(n++).padStart(4, "0")}`, ledger, at, tx, contract: id, name, topics, data });
  const add = (who, x) => st.bal.set(who, (st.bal.get(who) ?? 0n) + x);
  const sqrt = (v) => { let x = v, y = (x + 1n) / 2n; while (y < x) { x = y; y = (x + v / x) / 2n; } return x; };
  return {
    id, feeBps, st, events,
    pool: () => ({ id, type: "limeswap", tokenA: A, tokenB: B, feeBps, reserveA: st.a, reserveB: st.b, totalShares: st.s }),
    deposit(at, who, a, b) {
      ledger += 10; const tx = `tx${ledger}`;
      let shares;
      if (st.s === 0n) { shares = sqrt(a * b) - 1000n; st.s += 1000n; emit(tx, at, "mint", [id], { amount: 1000n }); }
      else shares = (a * st.s) / st.a < (b * st.s) / st.b ? (a * st.s) / st.a : (b * st.s) / st.b;
      st.s += shares; add(who, shares); st.a += a; st.b += b;
      emit(tx, at, "mint", [who], { amount: shares });
      emit(tx, at, "sync", [], { reserve_a: st.a, reserve_b: st.b });
      emit(tx, at, "deposit", [who], { amount_a: a, amount_b: b, shares });
      return shares;
    },
    swapAIn(at, who, x) {
      ledger += 10; const tx = `tx${ledger}`;
      const out = cpOut(x, st.a, st.b, feeBps);
      st.a += x; st.b -= out;
      emit(tx, at, "swap", [who], { in_a: x, in_b: 0n, out_a: 0n, out_b: out });
      emit(tx, at, "sync", [], { reserve_a: st.a, reserve_b: st.b });
      return out;
    },
    swapBIn(at, who, x) {
      ledger += 10; const tx = `tx${ledger}`;
      const out = cpOut(x, st.b, st.a, feeBps);
      st.b += x; st.a -= out;
      emit(tx, at, "swap", [who], { in_a: 0n, in_b: x, out_a: out, out_b: 0n });
      emit(tx, at, "sync", [], { reserve_a: st.a, reserve_b: st.b });
      return out;
    },
    withdraw(at, who, shares) {
      ledger += 10; const tx = `tx${ledger}`;
      const a = (shares * st.a) / st.s, b = (shares * st.b) / st.s;
      st.s -= shares; add(who, -shares); st.a -= a; st.b -= b;
      emit(tx, at, "burn", [who], { amount: shares });
      emit(tx, at, "sync", [], { reserve_a: st.a, reserve_b: st.b });
      emit(tx, at, "withdraw", [who], { amount_a: a, amount_b: b, shares });
    },
    transfer(at, from, to, x) {
      ledger += 10; const tx = `tx${ledger}`;
      add(from, -x); add(to, x);
      emit(tx, at, "transfer", [from, to], x);
    },
  };
}
const hist = (events, fromAt = NOW - 30 * DAY) => ({ events, fromAt });
const usd1 = (_, raw) => Number(raw) / 1e7; // both tokens $1, 7 decimals

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("feeOf matches the contracts' floor maths", () => {
  assert.equal(feeOf(10_000_000n, 30), 30_000n);
  assert.equal(feeOf(1n, 30), 1n); // 1·0.997 floors to 0 → the whole unit is fee
  assert.equal(feeOf(0n, 30), 0n);
  assert.equal(feeOf(333n, 5), 1n);
});

test("backwards rebuild reproduces every state of the simulated pool", () => {
  const s = simPool();
  const states = [];
  const snap = () => states.push({ a: s.st.a, b: s.st.b, s: s.st.s });
  s.deposit(NOW - 9 * DAY, ME, 1_000_0000000n, 1_000_0000000n); snap();
  s.swapAIn(NOW - 8 * DAY, YOU, 10_0000000n); snap();
  s.deposit(NOW - 3 * DAY, YOU, 500_0000000n, 500_0000000n); snap();
  s.swapBIn(NOW - 2 * DAY, YOU, 25_0000000n); snap();
  s.withdraw(NOW - DAY, YOU, 100_0000000n); snap();
  const { txs, mismatches } = poolTxs(s.pool(), s.events);
  assert.equal(mismatches, 0);
  assert.deepEqual(txs.map((t) => t.post), states);
  assert.deepEqual(txs[0].pre, { a: 0n, b: 0n, s: 0n });
});

test("sync events win over our sums, and disagreements are counted", () => {
  const s = simPool();
  s.deposit(NOW - 2 * DAY, ME, 100_0000000n, 100_0000000n);
  s.swapAIn(NOW - DAY, YOU, 1_0000000n);
  const pool = { ...s.pool(), reserveA: s.st.a + 5n }; // state read one ledger later, after a donation
  const { txs, mismatches } = poolTxs(pool, s.events);
  assert.equal(mismatches, 1);
  assert.equal(txs.at(-1).post.a, s.st.a); // the last sync, not our off-by-5 state
});

test("pool fees, 24 h fees and APR over the window", () => {
  const s = simPool();
  s.deposit(NOW - 10 * DAY, ME, 1_000_0000000n, 1_000_0000000n);
  s.swapAIn(NOW - 9 * DAY, YOU, 50_0000000n); // before the window: not counted
  s.swapAIn(NOW - 3 * DAY, YOU, 10_0000000n);
  s.swapBIn(NOW - 3600, YOU, 20_0000000n);
  const e = poolEarnings(s.pool(), hist(s.events), { now: NOW });
  assert.equal(e.swaps, 2);
  assert.equal(e.feesA, feeOf(10_0000000n, 30));
  assert.equal(e.feesB, feeOf(20_0000000n, 30));
  assert.equal(e.fees24A, 0n);
  assert.equal(e.fees24B, feeOf(20_0000000n, 30));
  assert.equal(e.since, NOW - 7 * DAY);
  assert.equal(e.volumeA, 10_0000000n);
  const v = priceEarnings(s.pool(), e, usd1);
  assert.ok(Math.abs(v.feesUsd - 0.09) < 1e-9); // 0.03 + 0.06
  assert.ok(Math.abs(v.apr - (v.feesUsd / v.tvlUsd) * (365 / 7)) < 1e-12);
});

test("a pool born inside the window counts from its first deposit; APR waits for a full day", () => {
  const s = simPool();
  s.deposit(NOW - 12 * 3600, ME, 100_0000000n, 100_0000000n);
  s.swapAIn(NOW - 6 * 3600, YOU, 1_0000000n);
  const e = poolEarnings(s.pool(), hist(s.events), { now: NOW });
  assert.equal(e.since, NOW - 12 * 3600);
  assert.equal(e.feesA, feeOf(1_0000000n, 30));
  assert.equal(priceEarnings(s.pool(), e, usd1).apr, null);
  assert.equal(poolEarnings(simPool().pool(), hist([]), { now: NOW }), null); // never funded
});

test("only the RPC-covered part of the window counts", () => {
  const s = simPool();
  s.deposit(NOW - 10 * DAY, ME, 100_0000000n, 100_0000000n);
  s.swapAIn(NOW - 5 * DAY, YOU, 1_0000000n);
  s.swapAIn(NOW - 2 * DAY, YOU, 1_0000000n);
  const e = poolEarnings(s.pool(), hist(s.events, NOW - 3 * DAY), { now: NOW });
  assert.equal(e.since, NOW - 3 * DAY);
  assert.equal(e.swaps, 1);
});

test("your fees follow your share at each swap; vs-holding splits into fees + price effect", () => {
  const s = simPool();
  s.deposit(NOW - 10 * DAY, ME, 1_000_0000000n, 1_000_0000000n);
  const mine = s.st.bal.get(ME);
  const sh = [];
  const x1 = 40_0000000n; sh.push([x1, s.st.s]); s.swapAIn(NOW - 5 * DAY, YOU, x1);
  s.deposit(NOW - 4 * DAY, YOU, 1_000_0000000n, (1_000_0000000n * s.st.b) / s.st.a); // at the pool ratio, like the router; my share halves
  const x2 = 40_0000000n; sh.push([x2, s.st.s]); s.swapAIn(NOW - 2 * DAY, YOU, x2);
  const e = poolEarnings(s.pool(), hist(s.events), { now: NOW, user: ME, shares: mine });
  const expect = sh.reduce((t, [x, supply]) => t + (feeOf(x, 30) * mine) / supply, 0n);
  assert.equal(e.user.feesA, expect);
  assert.equal(e.user.feesB, 0n);
  assert.equal(e.user.since, NOW - 7 * DAY); // my shares didn't change in the window
  // Price A at the pool's own price now (as the app's usdPrices does), B = $1.
  const mid = Number(s.st.b) / Number(s.st.a);
  const v = priceEarnings(s.pool(), e, (id, raw) => (Number(raw) / 1e7) * (id === A ? mid : 1)).user;
  assert.ok(Math.abs(v.vsHoldUsd - (v.nowUsd - v.holdUsd)) < 1e-9);
  assert.ok(Math.abs(v.feesUsd + v.priceUsd - v.vsHoldUsd) < 1e-9);
  assert.ok(v.feesUsd > 0);
  assert.ok(v.priceUsd < 0); // the price moved: impermanent loss
});

test("a deposit, withdrawal or LP transfer restarts your period (shares constant since)", () => {
  const s = simPool();
  s.deposit(NOW - 10 * DAY, ME, 1_000_0000000n, 1_000_0000000n);
  s.swapAIn(NOW - 5 * DAY, YOU, 40_0000000n);
  s.deposit(NOW - 3 * DAY, YOU, 100_0000000n, 100_0000000n);
  s.transfer(NOW - 2 * DAY, YOU, ME, 1_0000000n);
  const supplyThen = s.st.s;
  s.swapAIn(NOW - DAY, YOU, 40_0000000n);
  const mine = s.st.bal.get(ME);
  const e = poolEarnings(s.pool(), hist(s.events), { now: NOW, user: ME, shares: mine });
  assert.equal(e.user.since, NOW - 2 * DAY);
  assert.equal(e.user.feesA, (feeOf(40_0000000n, 30) * mine) / supplyThen);
  // start = what my shares held right after the transfer
  const after = poolTxs(s.pool(), s.events).txs.find((t) => t.at === NOW - 2 * DAY).post;
  assert.equal(e.user.startA, (mine * after.a) / after.s);
  // YOU withdrew nothing but deposited 3 days ago: their period starts then
  const y = poolEarnings(s.pool(), hist(s.events), { now: NOW, user: YOU, shares: s.st.bal.get(YOU) });
  assert.equal(y.user.since, NOW - 2 * DAY); // the transfer moved their shares too
  s.withdraw(NOW - 600, ME, mine / 2n);
  const w = poolEarnings(s.pool(), hist(s.events), { now: NOW, user: ME, shares: s.st.bal.get(ME) });
  assert.equal(w.user.since, NOW - 600);
  assert.equal(w.user.feesA, 0n);
});

test("no shares → no user block; unpriced tokens give NaN, not a wrong number", () => {
  const s = simPool();
  s.deposit(NOW - 2 * DAY, ME, 100_0000000n, 100_0000000n);
  assert.equal(poolEarnings(s.pool(), hist(s.events), { now: NOW, user: YOU, shares: 0n }).user, null);
  const v = priceEarnings(s.pool(), poolEarnings(s.pool(), hist(s.events), { now: NOW }), (id, raw) => (id === A ? Number(raw) : NaN));
  assert.ok(Number.isNaN(v.feesUsd));
});

test("LimeFX: the fee comes from each swap event (dynamic), no sync needed", () => {
  const pool = { id: FX, type: "fx", tokenA: A, tokenB: B, reserveA: 1_000_0000000n + 10_0000000n, reserveB: 1_120_0000000n - 11_1700000n, totalShares: 1_000_0000000n };
  const ev = (id, ledger, at, tx, name, topics, data) => ({ id, ledger, at, tx, contract: FX, name, topics, data });
  const events = [
    ev("a1", 10, NOW - 9 * DAY, "t1", "mint", [ME], { amount: 1_000_0000000n }),
    ev("a2", 10, NOW - 9 * DAY, "t1", "deposit", [ME], { amount_a: 1_000_0000000n, amount_b: 1_120_0000000n, shares: 1_000_0000000n }),
    ev("b1", 20, NOW - DAY / 2, "t2", "swap", [YOU, YOU], { in_a: 10_0000000n, in_b: 0n, out_a: 0n, out_b: 11_1700000n, fee_bps: 13, oracle_price: 1n }),
  ];
  const { txs } = poolTxs(pool, events);
  assert.deepEqual(txs[0].pre, { a: 0n, b: 0n, s: 0n });
  const e = poolEarnings(pool, hist(events), { now: NOW, user: ME, shares: 1_000_0000000n });
  assert.equal(e.feesA, feeOf(10_0000000n, 13));
  assert.equal(e.fees24A, e.feesA);
  assert.equal(e.user.feesA, e.feesA); // ME holds every share
});

test("LimeFX withdraw without a burn event still lowers the LP supply", () => {
  const pool = { id: FX, type: "fx", tokenA: A, tokenB: B, reserveA: 90n, reserveB: 99n, totalShares: 900n };
  const events = [{ id: "w", ledger: 9, at: NOW - 10, tx: "t", contract: FX, name: "withdraw", topics: [ME], data: { amount_a: 10n, amount_b: 11n, shares: 100n } }];
  const { txs } = poolTxs(pool, events);
  assert.deepEqual(txs[0].pre, { a: 100n, b: 110n, s: 1000n });
  assert.ok(txs[0].moved.has(ME));
});

test("compliance force_redeem: both sides leave the pool", () => {
  const pool = { id: P, type: "limeswap", tokenA: A, tokenB: B, feeBps: 30, reserveA: 90n, reserveB: 180n, totalShares: 90n };
  const events = [{ id: "x", ledger: 5, at: NOW - 10, tx: "t", contract: P, name: "force_redeem", topics: [YOU, A], data: { seized: 10n, other: 20n, shares: 10n, released: true, to: ME } },
    { id: "y", ledger: 5, at: NOW - 10, tx: "t", contract: P, name: "burn", topics: [YOU], data: { amount: 10n } }];
  assert.deepEqual(poolTxs(pool, events).txs[0].pre, { a: 100n, b: 200n, s: 100n });
});

test("entry: your own deposit is a known start; an older position starts where history starts", () => {
  const s = simPool();
  s.deposit(NOW - 10 * DAY, ME, 1_000_0000000n, 1_000_0000000n); // before the window
  s.swapAIn(NOW - 5 * DAY, YOU, 10_0000000n);
  s.deposit(NOW - 3 * DAY, YOU, 100_0000000n, (100_0000000n * s.st.b) / s.st.a);
  const me = poolEarnings(s.pool(), hist(s.events), { now: NOW, user: ME, shares: s.st.bal.get(ME) });
  assert.equal(me.user.known, false);
  assert.equal(me.user.since, NOW - 7 * DAY);
  const you = poolEarnings(s.pool(), hist(s.events), { now: NOW, user: YOU, shares: s.st.bal.get(YOU) });
  assert.equal(you.user.known, true);
  assert.equal(you.user.since, NOW - 3 * DAY);
  // The creator of a pool born inside the window: their first deposit is their entry.
  const n = simPool();
  n.deposit(NOW - 2 * DAY, ME, 100_0000000n, 100_0000000n);
  n.swapAIn(NOW - DAY, YOU, 1_0000000n);
  const c = poolEarnings(n.pool(), hist(n.events), { now: NOW, user: ME, shares: n.st.bal.get(ME) });
  assert.equal(c.user.known, true);
  assert.equal(c.user.since, NOW - 2 * DAY);
  assert.equal(c.user.feesA, (feeOf(1_0000000n, 30) * n.st.bal.get(ME)) / n.st.s);
});

test("stateAt / poolsAt rebuild a pool to any moment; its price then", () => {
  const s = simPool();
  s.deposit(NOW - 9 * DAY, ME, 1_000_0000000n, 2_000_0000000n); // 2 B per A
  s.swapAIn(NOW - 5 * DAY, YOU, 100_0000000n);
  const mid5 = Number(s.st.b) / Number(s.st.a);
  s.swapBIn(NOW - DAY, YOU, 300_0000000n);
  const { txs } = poolTxs(s.pool(), s.events);
  assert.deepEqual(stateAt(s.pool(), txs, NOW - 8 * DAY), { a: 1_000_0000000n, b: 2_000_0000000n, s: txs[0].post.s });
  assert.deepEqual(stateAt(s.pool(), txs, NOW - 10 * DAY), { a: 0n, b: 0n, s: 0n }); // before it existed
  assert.deepEqual(stateAt(s.pool(), txs, NOW), { a: s.st.a, b: s.st.b, s: s.st.s });
  const then = poolsAt([s.pool()], null, hist(s.events), NOW - 3 * DAY);
  assert.ok(Math.abs(then.pools[0].mid - mid5) < 1e-12); // flat for the last 10 min: TWAP = spot
  assert.equal(then.fx, null);
});

test("twapAt: a swap seconds before a deposit barely moves the entry price", () => {
  const s = simPool();
  s.deposit(NOW - DAY, ME, 10_000_0000000n, 1_000_0000000n); // 0.1 B per A
  const before = Number(s.st.b) / Number(s.st.a);
  s.swapBIn(NOW - 45, YOU, 1_000_0000000n); // pumps A's price ~4×, 45 s before "now"
  const spike = Number(s.st.b) / Number(s.st.a);
  const { txs } = poolTxs(s.pool(), s.events);
  const twap = twapAt(s.pool(), txs, NOW);
  assert.ok(spike > 3.5 * before);
  assert.ok(Math.abs(twap - (before * 555 + spike * 45) / 600) < 1e-12);
  assert.ok(twap < 1.4 * before);
  assert.ok(Number.isNaN(twapAt(s.pool(), txs, NOW - 2 * DAY))); // pool didn't exist yet
});

test("fxPriceAt: LimeFX's oracle price from the nearest swap event", () => {
  const fx = { id: FX };
  const sw = (id, at, price) => ({ id, ledger: 1, at, tx: id, contract: FX, name: "swap", topics: [YOU, YOU], data: { in_a: 1n, in_b: 0n, out_a: 0n, out_b: 1n, fee_bps: 5, oracle_price: price } });
  const events = [sw("1", NOW - 5 * DAY, 110_000_000_000_000n), sw("2", NOW - 2 * DAY, 112_000_000_000_000n)];
  const scale = 100_000_000_000_000n;
  assert.equal(fxPriceAt(fx, events, NOW - 3 * DAY, scale), 1.10); // last one before
  assert.equal(fxPriceAt(fx, events, NOW, scale), 1.12);
  assert.equal(fxPriceAt(fx, events, NOW - 6 * DAY, scale), 1.10); // none before: first one after
  assert.equal(fxPriceAt(fx, [], NOW, scale), null);
});

// ---------- Fetching ----------

/** Fake RPC: holds events by ledger, answers range and cursor queries like stellar-rpc (10k-ledger scans). */
function fakeServer(raw, { latest = 50_000, oldest = 1_000 } = {}) {
  const calls = [];
  const enc = (l) => ((BigInt(l) << 32n).toString().padStart(19, "0") + "-4294967295");
  return {
    calls,
    async getHealth() { return { latestLedger: latest, oldestLedger: oldest, oldestLedgerCloseTime: String(NOW - 7.7 * DAY | 0), latestLedgerCloseTime: String(NOW) }; },
    async getEvents(req) {
      calls.push(req);
      const ids = new Set(req.filters.flatMap((f) => f.contractIds));
      assert.ok(req.filters.length <= 5 && req.filters.every((f) => f.contractIds.length <= 5));
      let from, to;
      if (req.cursor) { from = Number(BigInt(req.cursor.split("-")[0]) >> 32n) + 1; to = from + 10_000; }
      else { from = req.startLedger; to = Math.min(req.endLedger, from + 10_000); }
      const hits = raw.filter((e) => e.ledger >= from && e.ledger < to && ids.has(e.contract));
      const page = hits.slice(0, req.limit);
      const last = page.length === req.limit ? page.at(-1).ledger - 1 : to - 1;
      return { events: page.map(toRpc), cursor: enc(Math.min(last, latest)), latestLedger: latest };
    },
  };
}
// Minimal stand-ins for RPC's ScVal fields (decodeEvent runs scValToNative on them).
import { nativeToScVal } from "@stellar/stellar-sdk";
const toRpc = (e) => ({
  id: e.id, ledger: e.ledger, ledgerClosedAt: new Date(e.at * 1000).toISOString(), txHash: e.tx, contractId: e.contract,
  topic: [nativeToScVal(e.name, { type: "symbol" }), ...e.topics.map((t) => nativeToScVal(t, { type: "string" }))],
  value: nativeToScVal(e.data, { type: { amount: ["symbol", "i128"] } }),
});
const mkEvent = (contract, ledger, i = 0) => ({ id: `${String(ledger).padStart(10, "0")}-${i}`, ledger, at: NOW - 1000, tx: `t${ledger}`, contract, name: "mint", topics: [ME], data: { amount: BigInt(ledger) } });

test("fetchEvents: 10k-ledger chunks, ≤5×5 ids per request, keeps only the range, decodes bigints", async () => {
  const ids = Array.from({ length: 27 }, (_, i) => `C${i}`);
  const raw = [mkEvent("C0", 1500), mkEvent("C26", 23_456), mkEvent("C3", 39_999), mkEvent("C3", 40_000), mkEvent("CX", 2000)];
  const srv = fakeServer(raw);
  const { events: got, latestLedger } = await fetchEvents(srv, ids, 1000, 40_000);
  assert.equal(latestLedger, 50_000);
  assert.deepEqual(got.map((e) => e.ledger), [1500, 23_456, 39_999]);
  assert.equal(got[0].data.amount, 1500n);
  assert.equal(got[0].name, "mint");
  assert.equal(srv.calls.length, 2 * 4); // 2 id groups × 4 chunks of ≤10k ledgers
});

test("fetchEvents continues by cursor when a page is full", async () => {
  const raw = Array.from({ length: 12_345 }, (_, i) => mkEvent("C0", 2000 + Math.floor(i / 3), i % 3));
  const { events: got } = await fetchEvents(fakeServer(raw), ["C0"], 1000, 11_000);
  assert.equal(got.length, 12_345);
});

test("loadHistory caches and only asks for new ledgers next time; drops a cache from before a reset", async () => {
  let store = null;
  const cache = { get: () => store, set: (s) => (store = s) };
  const srv = fakeServer([mkEvent("C0", 1500), mkEvent("C0", 30_000)], { latest: 35_000 });
  const h1 = await loadHistory(srv, ["C0"], { cache });
  assert.equal(h1.events.length, 2);
  assert.ok(h1.fromAt > NOW - 7.7 * DAY && h1.fromAt < NOW - 7.6 * DAY); // oldest + 60 ledgers
  assert.equal(h1.toLedger, 35_001);
  // Next time, up to the ledger the screen's state was read at: no getHealth, only new ledgers.
  const srv2 = fakeServer([mkEvent("C0", 1500), mkEvent("C0", 30_000), mkEvent("C0", 36_000)], { latest: 40_000 });
  let healthCalls = 0;
  const gh = srv2.getHealth; srv2.getHealth = () => (healthCalls++, gh());
  const h2 = await loadHistory(srv2, ["C0"], { cache, upTo: 38_000 });
  assert.equal(healthCalls, 0);
  assert.deepEqual(h2.events.map((e) => e.ledger), [30_000, 36_000]); // 1500 aged out: the window moved 3,000 ledgers
  assert.ok(srv2.calls.every((c) => c.startLedger >= 35_001 || c.cursor));
  assert.equal(h2.toLedger, 38_001);
  assert.equal(h2.events[0].data.amount, 30_000n); // bigints survive the JSON cache
  assert.ok(Math.abs(h2.toAt - (h1.toAt + 3_000 * ((7.7 * DAY | 0) / 34_000))) < 2);
  // RPC hasn't indexed the requested ledger yet: claim only what it had
  const srv3 = fakeServer([mkEvent("C0", 39_000)], { latest: 38_500 });
  const h3 = await loadHistory(srv3, ["C0"], { cache, upTo: 39_500 });
  assert.equal(h3.toLedger, 38_501);
  // Testnet reset: ledgers start over → the cache is ignored
  const srv4 = fakeServer([mkEvent("C0", 1200)], { latest: 2_000, oldest: 1 });
  const h4 = await loadHistory(srv4, ["C0"], { cache });
  assert.deepEqual(h4.events.map((e) => e.ledger), [1200]);
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL ${name}\n       ${String(e.stack ?? e).split("\n").slice(0, 14).join("\n       ")}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
