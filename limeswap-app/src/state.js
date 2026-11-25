// Batched state reads: every LimeSwap pool + LimeFX in ONE getLedgerEntries request, decoded from
// the contracts' own storage (same idea as lime-arb/venues.mjs). No DOM: shared with Node scripts.
//
// Storage layout read here (verified against simulated info()/compliance()/paused() on Testnet):
// - LimeSwap pool instance: TokenA, TokenB, FeeBps, ReserveA, ReserveB, Regulated (v3, absent =
//   off), Paused (OZ pausable, absent = false). LP supply: OZ TotalSupply, a *persistent* entry.
// - LimeFX instance: the same plus AssetA/AssetB, Oracle, OracleBase, OracleDecimals,
//   OracleResolution, Params, OutflowCap (absent = default), Flow.
// - Token instances: SAC "METADATA" {decimal, name: "CODE:ISSUER"|"native"}, OZ ["Meta"] {decimals}.
import { Address, Asset, Keypair, scValToNative, xdr } from "@stellar/stellar-sdk";
import { sv } from "./chain.js";
import { ratio } from "./format.js";

const PRICE_SCALE = 100_000_000_000_000n; // LimeFX oracle_price scale (1.0 = 10^14)
const POOL_LIST_TTL_MS = 5 * 60_000; // the factory's pool list: re-read every 5 minutes
const ORACLE_POLL_MS = 30_000; // while a new oracle price is due, look for it at most this often
const FX_DEFAULT_CAP = { capBps: 2_000, window: 3_600n }; // fx-pool DEFAULT_CAP_BPS / _WINDOW

const persistent = xdr.ContractDataDurability.persistent;
const dataKey = (id, key) =>
  xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({ contract: new Address(id).toScAddress(), key, durability: persistent }));
export const instanceKey = (id) => dataKey(id, xdr.ScVal.scvLedgerKeyContractInstance());
const totalSupplyKey = (id) => dataKey(id, xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("TotalSupply")]));
// The connected account's position in a pool: its LP shares (OZ FungibleStorageKey::Balance) and,
// LimeSwap pools only, tokens the pool holds for it after a payout failed (pool DataKey::Owed).
const userKey = (variant) => (id, user) => dataKey(id, xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(variant), new Address(user).toScVal()]));
const lpBalanceKey = userKey("Balance");
const owedKey = userKey("Owed");
const b64 = (k) => k.toXDR("base64");

/** Instance storage as a plain object: Symbol keys by name, unit enum keys (["Paused"]) by variant. */
function readInstance(entry) {
  const inst = entry.val.contractData.val.instance;
  const out = { _exec: inst.executable.type ?? inst.executable.switch?.().name };
  for (const e of inst.storage ?? []) {
    const k = scValToNative(e.key);
    out[Array.isArray(k) ? k.join(":") : k] = scValToNative(e.val);
  }
  return out;
}
const readValue = (entry) => scValToNative(entry.val.contractData.val);

// ---------- Small persistent cache (browser localStorage; memory only in Node) ----------
const memory = new Map();
const store = {
  get(k) {
    if (memory.has(k)) return memory.get(k);
    try {
      const v = typeof window !== "undefined" ? window.localStorage?.getItem(k) : null;
      if (v) memory.set(k, JSON.parse(v));
    } catch {}
    return memory.get(k);
  },
  set(k, v) {
    memory.set(k, v);
    try { if (typeof window !== "undefined") window.localStorage?.setItem(k, JSON.stringify(v)); } catch {}
  },
};

// ---------- Tokens: decimals + classic asset names (never change) ----------

/**
 * { id -> { decimals, name } } for the given token contracts. Cached forever per network+id;
 * misses are read in one getLedgerEntries request (falling back to simulating decimals()).
 */
export async function tokenMetadata(chain, ids) {
  const ck = (id) => `limeswap:token:${chain.config.passphrase}:${id}`;
  const out = new Map();
  const missing = ids.filter((id) => {
    const v = store.get(ck(id));
    if (v) out.set(id, v);
    return !v;
  });
  if (missing.length) {
    let found = new Map();
    try {
      found = (await chain.entries(missing.map(instanceKey))).entries;
    } catch {}
    await Promise.all(missing.map(async (id) => {
      const e = found.get(b64(instanceKey(id)));
      const s = e ? readInstance(e) : {};
      let meta = null;
      if (s.METADATA) meta = { decimals: Number(s.METADATA.decimal), name: String(s.METADATA.name) }; // SAC
      else if (s.Meta) meta = { decimals: Number(s.Meta.decimals), name: String(s.Meta.name) }; // OZ token
      if (meta) store.set(ck(id), meta);
      else meta = { decimals: Number(await chain.read(id, "decimals").catch(() => 7)), name: null };
      out.set(id, meta);
    }));
  }
  return out;
}

// ---------- Pools + LimeFX ----------

/** Factory pool list, cached for POOL_LIST_TTL_MS (or re-read with `relist`). */
function poolIds(chain, relist) {
  const c = chain.poolList;
  if (c && !relist && Date.now() - c.at < POOL_LIST_TTL_MS) return c.ids;
  return (chain.poolListPending ??= listPools(chain).finally(() => (chain.poolListPending = null)));
}

async function listPools(chain) {
  const ids = [];
  for (let start = 0; ; start += 50) {
    const page = await chain.read(chain.config.factory, "pools", sv.u32(start), sv.u32(50));
    ids.push(...page);
    if (page.length < 50) break;
  }
  chain.poolList = { ids, at: Date.now() };
  store.set(`limeswap:pools:${chain.config.passphrase}:${chain.config.factory}`, ids);
  return ids;
}

function poolFromStorage(id, s, supply) {
  const p = {
    type: "limeswap", id,
    tokenA: s.TokenA, tokenB: s.TokenB,
    reserveA: BigInt(s.ReserveA ?? 0), reserveB: BigInt(s.ReserveB ?? 0),
    feeBps: Number(s.FeeBps), totalShares: supply,
    regulated: s.Regulated ? [Boolean(s.Regulated[0]), Boolean(s.Regulated[1])] : [false, false],
    paused: Boolean(s.Paused),
  };
  p.mid = ratio(p.reserveB, p.reserveA); // price of A in B (same decimals)
  return p;
}

const sameAsset = (x, y) => JSON.stringify(x) === JSON.stringify(y);

function fxFromStorage(id, s, supply) {
  const params = s.Params;
  const cap = s.OutflowCap ? { capBps: Number(s.OutflowCap.cap_bps), window: BigInt(s.OutflowCap.window) } : FX_DEFAULT_CAP;
  const f = s.Flow;
  const p = {
    type: "fx", id, oracle: s.Oracle,
    tokenA: s.TokenA, tokenB: s.TokenB,
    reserveA: BigInt(s.ReserveA ?? 0), reserveB: BigInt(s.ReserveB ?? 0),
    totalShares: supply,
    assetA: s.AssetA, assetB: s.AssetB,
    params, regulated: [false, false],
    paused: Boolean(s.Paused),
    // Local-quote inputs (src/quote.js).
    amp: Number(params.amp), outflowCap: cap, priceScale: PRICE_SCALE,
    flow: f ? { start: BigInt(f.start), baseA: BigInt(f.base_a), baseB: BigInt(f.base_b), netOutA: BigInt(f.net_out_a), netOutB: BigInt(f.net_out_b) } : null,
    oracleBase: s.OracleBase, oracleDecimals: Number(s.OracleDecimals), oracleResolution: Number(s.OracleResolution ?? 300),
  };
  // The curve only needs p_a/p_b. When asset_b is the oracle's base, p_b = 10^decimals and
  // oracle_price = p_a·10^14/p_b is exact (decimals ≤ 14): (oracle_price, 10^14) is a bit-exact
  // substitute. Otherwise LimeFX routes are simulated.
  p.exact = sameAsset(s.AssetB, s.OracleBase) && p.oracleDecimals <= 14;
  p.band = [Number(params.min_price) / Number(PRICE_SCALE), Number(params.max_price) / Number(PRICE_SCALE)];
  return p;
}

/**
 * Oracle record timestamps (for the "updated N min ago" display). Only re-read when a new price
 * is due or the quote says the price changed: ~1 simulation per oracle update, not per refresh.
 */
async function oracleRecords(chain, fx, quote, now) {
  const o = (chain.oracleCache ??= {});
  const assets = [fx.assetA, fx.assetB].filter((a) => !sameAsset(a, fx.oracleBase));
  const due = !o.records || o.oracle !== fx.oracle || !quote.ok
    || quote.value.oracle_price !== o.price
    || (now >= o.ts + fx.oracleResolution && Date.now() - o.readAt > ORACLE_POLL_MS);
  if (due) {
    const rs = await Promise.all(assets.map((a) => chain.tryRead(fx.oracle, "lastprice", sv.asset(a))));
    const records = assets.map((a, i) => ({ asset: a, r: rs[i] }));
    const ts = rs.filter((r) => r.ok && r.value).map((r) => Number(r.value.timestamp));
    Object.assign(o, {
      oracle: fx.oracle, records, readAt: Date.now(),
      price: quote.ok ? quote.value.oracle_price : null,
      ts: ts.length ? Math.min(...ts) : 0,
    });
  }
  return o.records;
}

/** Oracle price/age fields of the LimeFX object, as loadFx() always returned them. */
function applyOracle(fx, quote, records, now) {
  const one = 10n ** BigInt(fx.oracleDecimals);
  // records null = timestamps not read yet (first load in fast mode): price from the quote,
  // age unknown until the next refresh.
  fx.oracleAge = null;
  const priceOf = (asset) => {
    if (sameAsset(asset, fx.oracleBase)) return { price: one, timestamp: null };
    const { r } = records.find((x) => sameAsset(x.asset, asset)) ?? {};
    if (!r?.ok) throw new Error(r?.error ?? "no oracle record");
    if (!r.value) throw new Error(`The oracle has no ${asset[1]} price.`);
    return { price: BigInt(r.value.price), timestamp: Number(r.value.timestamp) };
  };
  if (!records) {
    if (!quote.ok) fx.oracleError = "Reading the oracle…";
  } else try {
    const pa = priceOf(fx.assetA), pb = priceOf(fx.assetB);
    fx.oraclePrice = Number(pa.price) / Number(pb.price); // A in B
    const ts = [pa.timestamp, pb.timestamp].filter((t) => t !== null);
    fx.oracleTimestamp = ts.length ? Math.min(...ts) : null;
    fx.oracleAge = fx.oracleTimestamp ? now - fx.oracleTimestamp : null;
  } catch (e) {
    fx.oracleError = e.message;
  }
  if (quote.ok) {
    fx.feeBps = Number(quote.value.fee_bps);
    fx.oraclePriceRaw = BigInt(quote.value.oracle_price);
    fx.oraclePrice = Number(fx.oraclePriceRaw) / Number(PRICE_SCALE); // what LimeFX itself prices with
  } else {
    fx.quoteError = quote.error;
  }
}

/**
 * Snapshot of every LimeSwap pool and LimeFX. Requests per refresh: one getLedgerEntries (all
 * instances + LP supplies), one LimeFX quote simulation (dynamic fee + oracle price), plus the
 * factory list every few minutes and an oracle lastprice when a new price is due.
 * Returns { pools, fx, fxError, ledger, now }. Concurrent calls share one snapshot.
 * Options: `relist` re-reads the factory list now; `account: { user }` adds that account's XLM
 * and trustlines to the same request; `fast` (the app) never waits for the slow, rarely
 * changing parts: a stale pool list and the oracle timestamps are refreshed in the background
 * and show up on the next refresh (on a first visit the oracle age is "unknown" for one ledger).
 */
export function loadState(chain, { relist = false, account = null, fast = false } = {}) {
  return (chain.statePending ??= readState(chain, relist, account, fast).finally(() => (chain.statePending = null)));
}

async function readState(chain, relist, account, fast) {
  const cfg = chain.config;
  const fxId = cfg.fx?.pool ?? null;
  const listed = chain.poolList && !relist && Date.now() - chain.poolList.at < POOL_LIST_TTL_MS ? chain.poolList.ids : null;
  // Cold start: read the pools we know from deploy time while the factory list loads.
  const guess = listed ?? chain.poolList?.ids ?? store.get(`limeswap:pools:${cfg.passphrase}:${cfg.factory}`) ?? cfg.poolHints ?? [];
  // Fast mode with a known list: use it now, refresh it in the background.
  let idsP = listed ?? poolIds(chain, relist);
  if (fast && !listed && !relist && guess.length) {
    idsP.catch(() => {});
    idsP = guess;
  }
  const fxMeta = fxId ? store.get(`limeswap:fx:${cfg.passphrase}:${fxId}`) : null;
  // With an account connected, its LP shares and owed tokens in every pool ride along too.
  const user = account?.user?.startsWith("G") ? account.user : null;
  const keysFor = (id) => [instanceKey(id), totalSupplyKey(id), ...(user ? [lpBalanceKey(id, user), owedKey(id, user)] : [])];
  const readEntries = (ids, more = []) => chain.entries([...ids.flatMap(keysFor), ...more]);
  // The connected account's XLM + trustlines ride along in the same request (see accountState).
  const acct = account?.user?.startsWith("G") && chain.classic ? accountKeys(account.user, classicAssets(chain)) : null;
  const fxQuote = fxId ? chain.tryRead(fxId, "quote", sv.addr(fxMeta?.tokenA ?? cfg.tokens.leur), sv.i128(10n ** 7n)) : null;
  // First load of this page with LimeFX's oracle known from an earlier visit: read the oracle
  // timestamps alongside the quote instead of one refresh later.
  const recordsP = fast && fxMeta?.oracle && !chain.oracleCache?.records
    ? oracleRecords(chain, fxMeta, { ok: false }, 0).catch(() => null) : null;

  const [first, ids, quote, now] = await Promise.all([
    // (recordsP resolves alongside; awaited below)
    readEntries([...guess, ...(fxId ? [fxId] : [])], acct?.keys ?? []),
    idsP,
    fxQuote,
    chain.closeTime && Date.now() / 1000 - chain.closeTime < 10 ? chain.closeTime : chain.now(),
  ]);
  let { entries, latestLedger } = first;
  if (acct) {
    const st = decodeAccount(entries, account.user, classicAssets(chain));
    chain.cache.set(acct.cacheKey, { p: Promise.resolve(st), at: Date.now() });
  }
  const extra = ids.filter((id) => !entries.has(b64(instanceKey(id))));
  if (extra.length) {
    const more = await readEntries(extra);
    for (const [k, v] of more.entries) entries.set(k, v);
    latestLedger = Math.max(latestLedger, more.latestLedger);
  }
  /** The account's position in pool `id` ({ shares, owed: [a, b] }), or undefined with no account. */
  const mineOf = (id) => {
    if (!user) return undefined;
    const bal = entries.get(b64(lpBalanceKey(id, user)));
    const owed = entries.get(b64(owedKey(id, user)));
    return { shares: bal ? BigInt(readValue(bal)) : 0n, owed: owed ? readValue(owed).map(BigInt) : [0n, 0n] };
  };
  const supplyOf = (id) => {
    const e = entries.get(b64(totalSupplyKey(id)));
    return e ? BigInt(readValue(e)) : null;
  };

  const pools = await Promise.all(ids.map(async (id) => {
    chain.kinds.set(id, "pool");
    const e = entries.get(b64(instanceKey(id)));
    let supply = supplyOf(id);
    if (!e) throw new Error(`Pool ${id.slice(0, 6)}… has no readable state (archived?).`);
    const s = readInstance(e);
    // No supply entry: either never minted (0) or archived; info() tells (and restores nothing).
    if (supply === null) supply = s.ReserveA ? BigInt((await chain.read(id, "info")).total_shares) : 0n;
    const p = poolFromStorage(id, s, supply);
    p.mine = mineOf(id);
    p.twap = chain.twaps?.get(id) ?? { pending: true };
    return p;
  }));

  let fx = null, fxError;
  if (fxId) {
    try {
      const e = entries.get(b64(instanceKey(fxId)));
      if (!e) throw new Error("LimeFX state not found.");
      fx = fxFromStorage(fxId, readInstance(e), supplyOf(fxId) ?? 0n);
      fx.mine = mineOf(fxId);
      const meta = { tokenA: fx.tokenA, oracle: fx.oracle, assetA: fx.assetA, assetB: fx.assetB, oracleBase: fx.oracleBase, oracleResolution: fx.oracleResolution };
      if (JSON.stringify(meta) !== JSON.stringify(fxMeta)) store.set(`limeswap:fx:${cfg.passphrase}:${fxId}`, meta);
      // The quote used the cached/configured token A; if that was wrong (another pair), ask again.
      const q = quote.ok || fxMeta?.tokenA === fx.tokenA || cfg.tokens.leur === fx.tokenA
        ? quote : await chain.tryRead(fxId, "quote", sv.addr(fx.tokenA), sv.i128(10n ** 7n));
      let records;
      if (recordsP && (await recordsP) && chain.oracleCache.oracle === fx.oracle) {
        records = chain.oracleCache.records;
        if (q.ok) chain.oracleCache.price = q.value.oracle_price; // read at the same time as the quote
      } else if (fast && chain.oracleCache?.records) {
        // Show the last known timestamps now; a due re-read lands on the next refresh.
        records = chain.oracleCache.records;
        oracleRecords(chain, fx, q, now).catch(() => {});
      } else if (fast) {
        oracleRecords(chain, fx, q, now).catch(() => {});
        records = null;
      } else {
        records = await oracleRecords(chain, fx, q, now);
      }
      applyOracle(fx, q, records, now);
      fx.now = now;
    } catch (err) {
      fx = null;
      fxError = err.message;
    }
  }
  return { pools, fx, fxError, ledger: latestLedger, now };
}

/** 10-minute TWAP of each pool (one simulation each: off the critical path, Pools tab only). */
export async function loadTwaps(chain, pools) {
  chain.twaps ??= new Map();
  await Promise.all(pools.map(async (p) => {
    const r = await chain.tryRead(p.id, "twap", sv.u64(600));
    let t;
    if (r.ok) {
      const [aInB, , window] = r.value;
      t = { price: Number(aInB) / Number(PRICE_SCALE), window: Number(window) };
    } else {
      t = { error: r.error };
    }
    chain.twaps.set(p.id, t);
    p.twap = t;
  }));
}

// ---------- Connected account: XLM + trustlines in one request ----------

/**
 * { exists, balance, lines: Map(asset "CODE:ISSUER" -> { balance, flags }) } for a G-account,
 * reading the account entry and its trustlines for `assets` in one getLedgerEntries request.
 * Cached per ledger, so the Swap, Liquidity and onboarding panels share it.
 */
export function accountState(chain, user, assets) {
  const { cacheKey, keys } = accountKeys(user, assets);
  return chain.cached(cacheKey, async () => decodeAccount((await chain.entries(keys)).entries, user, assets));
}

function accountKeys(user, assets) {
  const list = [...new Set(assets)].sort();
  const accountId = Keypair.fromPublicKey(user).xdrAccountId();
  const acctKey = xdr.LedgerKey.account(new xdr.LedgerKeyAccount({ accountId }));
  const tlKeys = list.map((a) => {
    const [code, issuer] = a.split(":");
    return xdr.LedgerKey.trustline(new xdr.LedgerKeyTrustLine({ accountId, asset: new Asset(code, issuer).toTrustLineXDRObject() }));
  });
  return { cacheKey: `acct|${user}|${list.join(",")}`, keys: [acctKey, ...tlKeys], acctKey, tlKeys, list };
}

function decodeAccount(entries, user, assets) {
  const { acctKey, tlKeys, list } = accountKeys(user, assets);
  const acct = entries.get(b64(acctKey))?.val.account;
  const lines = new Map();
  list.forEach((a, i) => {
    const tl = entries.get(b64(tlKeys[i]))?.val.trustLine;
    if (tl) lines.set(a, { balance: BigInt(tl.balance), flags: Number(tl.flags) });
  });
  return { exists: Boolean(acct), balance: acct ? BigInt(acct.balance) : null, lines };
}

/** The classic assets whose trustlines balanceOf/trustStatus read (set by loadTokens). */
export const classicAssets = (chain) => [...(chain.classic?.values() ?? [])].filter((a) => a !== "native");

/** True when every token's metadata is already cached (loadTokens then needs no request). */
export const tokensCached = (chain) =>
  Object.values(chain.config.tokens).every((id) => store.get(`limeswap:token:${chain.config.passphrase}:${id}`));
