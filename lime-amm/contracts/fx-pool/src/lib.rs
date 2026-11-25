#![no_std]
//! LimeFX pool: a two-stablecoin AMM whose curve is centred on an oracle price.
//!
//! A plain constant-product pool for EURC/USDC must be arbitraged every time EUR/USD moves,
//! and that arbitrage profit is paid by the LPs. Here the curve is re-centred on the oracle's
//! price on every swap, so a balanced pool always quotes the oracle price (minus fee).
//!
//! Curve ("virtual-reserve constant product around the oracle"):
//! - p = price of A in B = price(asset_a) / price(asset_b), read from a SEP-40 oracle.
//! - Value of the A reserve in B units: xv = x·p. Virtual liquidity V = amp·(xv + y)/2.
//! - Trades run on constant product over (xv + V, y + V) in B-value units, so at balance
//!   (xv = y) the marginal price is exactly p, and the price moves away from p gradually as the
//!   pool gets skewed (amp = 0 is a plain x·y = k pool). Payouts are capped by real reserves.
//!
//! Safety (all checked on every swap and quote):
//! - Hard price band: the cross price must lie in [`min_price`, `max_price`] (`PriceOutOfBand`).
//!   The other checks bound how *fast* the price may move; only the band bounds how *far*, so
//!   a compromised feed that walks the price slowly still cannot drain the pool.
//! - Freshness: prices older than `max_age` revert (`StalePrice`); timestamps more than 60 s in
//!   the future revert (`FutureTimestamp`); two non-base assets must be priced within one
//!   resolution of each other (`PriceSkew`); oracle `decimals()` must not change (`OracleChanged`).
//! - Circuit breaker: latest price more than `max_dev_bps` away from the mean of the previous
//!   `history` records (latest excluded) reverts (`PriceUnstable`).
//! - Dynamic fee = base + vol_mult·dev_bps + base·age/resolution, capped at `max_fee_bps`.
//!   While the price is moving or getting old the oracle lags the market, so LPs need more
//!   protection from latency arbitrage.
//! - `amp` changes are rate-limited (×2 / ÷2 at most, once per 24 h), because changing the
//!   curve shape moves the marginal price of a skewed pool and hands value to whoever trades
//!   right after.
//!
//! v2: `swap_in` and `deposit_raw` for routers (input sent first, like the cp pool's
//! `swap_raw`), so the LimeSwap router can route through LimeFX and deposit with fixed-amount auth.
//!
//! v3 safety and governance:
//! - **Outflow cap** (`set_outflow_cap`, default 20% per hour): within one fixed window, the
//!   *net* amount of each token that leaves through swaps (out − in) may not exceed `cap_bps` of
//!   that token's reserve (the smaller of: at the window's first swap, right now)
//!   (`OutflowCapExceeded`). So a feed that is
//!   wrong but inside the band can cost LPs at most ~cap per window (≤ 2× cap across a window
//!   boundary) before the guardian pauses. Net, not gross: honest two-way flow does not use up
//!   the cap, and an attacker can only "refill" it by paying the same token back in. LP
//!   deposits/withdrawals are never capped or counted. `quote` reverts exactly like `swap`.
//! - **Depeg guard** (`set_peg_guard`, off by default = v2 behaviour): an optional second SEP-40
//!   oracle that prices the *tokens* (e.g. EURC, USDC) in the same unit as the FX feed (USD).
//!   Each configured token's price must be within `max_dev_bps` of its fiat reference
//!   (EUR, USD) from the main feed, or swaps revert (`Depegged`); stale / missing / rescaled
//!   peg prices revert like main-feed ones.
//! - **Two-step admin** (`propose_admin` + `accept_admin`) so the admin can move to a timelock
//!   without risking a typo, and a **guardian** (`set_guardian`) that can only `pause`. Pause stays
//!   instant for emergencies; `unpause`, params, cap, peg guard and upgrade stay with the admin.
//! - Storage is v2-compatible: the new settings are separate keys read with defaults, so a live
//!   v2 pool upgrades in place.
//!
//! v4: `withdraw` emits the SEP-41 `burn` event for the LP shares it burns (v1–v3 only lowered
//! the supply silently, so indexers following token events overcounted LimeFX LP supply). No
//! storage change.
//!
//! Only the SEP-40 subset (`base`, `decimals`, `resolution`, `lastprice`, `prices`) is used,
//! so the pool works against Reflector or our mock oracle.
//!
//! Known limits:
//! - Deposits are not checked against the oracle: the first depositor sets the ratio and later
//!   depositors must protect themselves with `min_a` / `min_b`.
//! - No emergency single-token withdraw: if one token's issuer freezes the pool or an LP, that
//!   LP's withdraw reverts.
//! - The outflow window is fixed, not rolling (up to 2× cap around a boundary).
//! - The depeg guard assumes both oracles quote in the same unit (checked: same `base()`), and is
//!   only as good as the token-price feed (thin CEX/DEX markets can be pushed).

use soroban_sdk::{
    contract, contractclient, contracterror, contractevent, contractimpl, contracttype,
    panic_with_error, token::TokenClient, Address, BytesN, Env, MuxedAddress, String, Symbol, Vec,
    I256,
};
use stellar_contract_utils::math::i128_fixed_point::mul_div_floor;
use stellar_contract_utils::pausable::{self as pausable, Pausable};
use stellar_contract_utils::upgradeable;
use stellar_macros::when_not_paused;
use stellar_tokens::fungible::{
    burnable::emit_burn,
    total_supply::{decrease_total_supply, FungibleTotalSupply, TotalSupply},
    Base, Compose, ContractOverrides, FungibleToken,
};

#[cfg(test)]
mod test;

/// Bumped on every release.
pub const VERSION: u32 = 4;
/// Fee denominator: fees are in basis points.
pub const BPS: i128 = 10_000;
/// Shares burned forever on the first deposit (share-inflation protection, as in our cp pool).
pub const MINIMUM_LIQUIDITY: i128 = 1_000;
/// Fixed-point scale of the oracle price reported by `quote` / events: 1.0 == 10^14.
pub const PRICE_SCALE: i128 = 100_000_000_000_000;
/// Upper bound for `amp` (keeps every intermediate product far inside 256 bits).
pub const MAX_AMP: u32 = 10_000;
/// Highest fee the admin may set (10%).
pub const MAX_FEE_CAP: u32 = 1_000;
/// Max `history`: we request history + 1 records and Reflector returns None above 20.
pub const MAX_HISTORY: u32 = 19;
/// Oracle timestamps may be at most this far ahead of the ledger clock.
pub const MAX_FUTURE_SKEW: u64 = 60;
/// Max `amp` an empty-amp (cp) pool may jump to, and max `amp` that may drop to 0.
pub const AMP_FROM_ZERO_MAX: u32 = 10;
/// Min time between two `amp` changes.
pub const AMP_CHANGE_DELAY: u64 = 86_400;
/// v3 outflow cap defaults (used until the admin sets one, e.g. right after a v2 → v3 upgrade).
pub const DEFAULT_CAP_BPS: u32 = 2_000;
pub const DEFAULT_CAP_WINDOW: u64 = 3_600;
/// Bounds for the outflow window (1 minute .. 7 days).
pub const MIN_CAP_WINDOW: u64 = 60;
pub const MAX_CAP_WINDOW: u64 = 7 * 86_400;
/// Fallback when the oracle reports no resolution.
const DEFAULT_RESOLUTION: u64 = 300;
/// Deviation is measured in parts per million (1 bps = 100 ppm).
const PPM: i128 = 1_000_000;

const DAY_IN_LEDGERS: u32 = 17_280;
const TTL_THRESHOLD: u32 = 7 * DAY_IN_LEDGERS;
const TTL_EXTEND_TO: u32 = 30 * DAY_IN_LEDGERS;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum FxPoolError {
    Unauthorized = 1,
    InvalidAmount = 2,
    InsufficientLiquidity = 3,
    InsufficientOutput = 4,
    SlippageA = 5,
    SlippageB = 6,
    InvalidToken = 7,
    InvalidFee = 8,
    InsufficientShares = 9,
    SameToken = 10,
    Overflow = 11,
    /// Both tokens must use the same number of decimals (the curve compares raw amounts).
    DecimalsMismatch = 12,
    /// The oracle has no (positive) price for one of the assets.
    PriceMissing = 13,
    /// The oracle price is older than `max_age`.
    StalePrice = 14,
    /// Circuit breaker: latest price too far from the recent mean.
    PriceUnstable = 15,
    InvalidParams = 16,
    SameAsset = 17,
    /// Cross price outside the admin's hard band [min_price, max_price].
    PriceOutOfBand = 18,
    /// Only one `amp` change per AMP_CHANGE_DELAY.
    AmpChangeTooFast = 19,
    /// New `amp` outside [old/2, old·2] (or the 0 ↔ ≤10 rule).
    AmpChangeTooLarge = 20,
    /// The oracle's `decimals()` differs from the value seen at construction.
    OracleChanged = 21,
    /// Oracle timestamp more than MAX_FUTURE_SKEW seconds ahead of the ledger.
    FutureTimestamp = 22,
    /// The two assets' latest prices are more than one resolution apart.
    PriceSkew = 23,
    /// v3: this swap would push the window's net outflow of a token above the cap.
    OutflowCapExceeded = 24,
    /// v3: a token's market price is too far from its fiat reference (depeg guard).
    Depegged = 25,
}

// ---------------------------------------------------------------- SEP-40 subset

/// SEP-40 asset (same XDR shape as Reflector's `Asset`).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd)]
pub enum Asset {
    Stellar(Address),
    Other(Symbol),
}

/// SEP-40 price record.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd)]
pub struct PriceData {
    pub price: i128,
    pub timestamp: u64,
}

/// The only oracle calls this pool makes. Any SEP-40 oracle (Reflector Pulse, our mock) fits.
#[allow(dead_code)]
#[contractclient(name = "OracleClient")]
pub trait Sep40 {
    fn base(env: Env) -> Asset;
    fn decimals(env: Env) -> u32;
    fn resolution(env: Env) -> u32;
    fn lastprice(env: Env, asset: Asset) -> Option<PriceData>;
    fn prices(env: Env, asset: Asset, records: u32) -> Option<Vec<PriceData>>;
}

// ---------------------------------------------------------------- types

/// Tunable parameters (admin: `set_params`).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FxParams {
    /// Virtual liquidity multiplier: 0 = plain constant product; higher = flatter around the
    /// oracle price (≈ how many times deeper than a cp pool the pool feels near balance).
    pub amp: u32,
    /// Fee when the oracle is calm.
    pub base_fee_bps: u32,
    /// Ceiling for the dynamic fee.
    pub max_fee_bps: u32,
    /// Extra fee per bps of deviation from the recent mean (fee = base + vol_mult·dev_bps
    /// + base·age/resolution).
    pub vol_mult: u32,
    /// Circuit breaker: max |latest − mean of previous records| / mean, in bps.
    pub max_dev_bps: u32,
    /// Max age of an oracle price, in seconds.
    pub max_age: u64,
    /// Number of records before the latest one that form the mean (1..=19).
    pub history: u32,
    /// Hard band for the cross price of A in B (PRICE_SCALE): swaps revert outside it.
    pub min_price: i128,
    pub max_price: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FxInfo {
    pub token_a: Address,
    pub token_b: Address,
    pub reserve_a: i128,
    pub reserve_b: i128,
    pub total_shares: i128,
    pub oracle: Address,
    pub asset_a: Asset,
    pub asset_b: Asset,
    pub params: FxParams,
}

/// What a swap would get right now.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Quote {
    pub amount_out: i128,
    pub fee_bps: u32,
    /// Oracle price of token A in token B, scaled by PRICE_SCALE.
    pub oracle_price: i128,
}

/// v3: max net outflow per token through swaps, per fixed window (admin: `set_outflow_cap`).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OutflowCap {
    /// Fraction of the token's reserve at the window's first swap, in bps (1..=10 000).
    pub cap_bps: u32,
    /// Window length in seconds.
    pub window: u64,
}

/// v3: swap flow in the current window (view: `flow`).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FlowWindow {
    /// Ledger timestamp of the window's first swap.
    pub start: u64,
    /// Reserves when the window started (the cap is a fraction of these).
    pub base_a: i128,
    pub base_b: i128,
    /// Net amount that left through swaps (out − in); negative when more came in.
    pub net_out_a: i128,
    pub net_out_b: i128,
}

/// v3: which asset on the peg oracle prices a token (`Unchecked` = don't check that side).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PegAsset {
    Unchecked,
    Asset(Asset),
}

/// v3: optional depeg guard (admin: `set_peg_guard`). `peg_oracle` prices the tokens themselves
/// (e.g. EURC, USDC) in the same base unit as the main FX feed (e.g. USD).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PegGuard {
    pub oracle: Address,
    /// The token's asset on `oracle` (e.g. Other("EURC")), or `Unchecked`.
    pub asset_a: PegAsset,
    pub asset_b: PegAsset,
    /// Max |token price − fiat reference| / fiat reference, in bps.
    pub max_dev_bps: u32,
    /// Max age of a peg price, in seconds.
    pub max_age: u64,
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Admin,
    TokenA,
    TokenB,
    Oracle,
    AssetA,
    AssetB,
    /// Cached at construction: oracle base asset and decimals never change in live feeds.
    OracleBase,
    OracleDecimals,
    OracleResolution,
    Params,
    /// Ledger timestamp of the last `amp` change (absent until the first change).
    AmpChangedAt,
    ReserveA,
    ReserveB,
    // v3 (absent in v2 storage; read with defaults)
    OutflowCap,
    Flow,
    PegGuard,
    PegDecimals,
    PendingAdmin,
    Guardian,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Deposit {
    #[topic]
    pub provider: Address,
    pub amount_a: i128,
    pub amount_b: i128,
    pub shares: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Withdraw {
    #[topic]
    pub provider: Address,
    pub amount_a: i128,
    pub amount_b: i128,
    pub shares: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Swap {
    #[topic]
    pub from: Address,
    #[topic]
    pub to: Address,
    pub in_a: i128,
    pub in_b: i128,
    pub out_a: i128,
    pub out_b: i128,
    pub fee_bps: u32,
    /// Oracle price of A in B used for this swap, scaled by PRICE_SCALE.
    pub oracle_price: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ParamsSet {
    pub params: FxParams,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OutflowCapSet {
    pub cap: OutflowCap,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PegGuardSet {
    /// The peg oracle, or None when the guard was removed.
    pub oracle: Option<Address>,
    pub max_dev_bps: u32,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdminProposed {
    pub current: Address,
    pub pending: Address,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdminChanged {
    pub previous: Address,
    pub admin: Address,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GuardianSet {
    pub guardian: Option<Address>,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Upgraded {
    pub from_version: u32,
    pub new_wasm_hash: BytesN<32>,
}

// ---------------------------------------------------------------- math

/// Integer square root (floor), same as our cp pool.
fn isqrt(e: &Env, x: &I256) -> i128 {
    let zero = I256::from_i32(e, 0);
    if *x == zero {
        return 0;
    }
    let one = I256::from_i32(e, 1);
    let two = I256::from_i32(e, 2);
    let mut z = x.clone();
    let mut y = x.div(&two).add(&one);
    while y < z {
        z = y.clone();
        y = x.div(&y).add(&y).div(&two);
    }
    z.to_i128().unwrap_or_else(|| panic_with_error!(e, FxPoolError::Overflow))
}

/// Curve output for `amount_in` (already net of fee), all values in a common unit:
/// token amount × its oracle price (both prices have the same decimals, so p = p_in / p_out).
///
///   X = 2·r_in·p_in + V,  Y = 2·r_out·p_out + V,  V = amp·(r_in·p_in + r_out·p_out)
///   out = Y·din / ((X + din) · 2·p_out),  din = 2·amount_in·p_in
///
/// This is constant product on the virtual reserves (xv + V, y + V), multiplied through by
/// 2·p_out so nothing is divided before the final floor (rounding always favours the pool).
/// amp = 0 reduces exactly to r_out·in / (r_in + in).
pub fn curve_out(e: &Env, amount_in: i128, r_in: i128, r_out: i128, p_in: i128, p_out: i128, amp: u32) -> i128 {
    if amount_in <= 0 {
        return 0;
    }
    let i = |v: i128| I256::from_i128(e, v);
    let two = i(2);
    let w_in = i(r_in).mul(&i(p_in));
    let w_out = i(r_out).mul(&i(p_out));
    let v = i(amp as i128).mul(&w_in.add(&w_out));
    let x = two.mul(&w_in).add(&v);
    let y = two.mul(&w_out).add(&v);
    let din = two.mul(&i(amount_in)).mul(&i(p_in));
    let out = y.mul(&din).div(&x.add(&din).mul(&two).mul(&i(p_out)));
    out.to_i128().unwrap_or_else(|| panic_with_error!(e, FxPoolError::Overflow))
}

// ---------------------------------------------------------------- storage helpers

fn get_i128(e: &Env, key: &DataKey) -> i128 {
    e.storage().instance().get(key).unwrap_or(0)
}

fn token_a(e: &Env) -> Address {
    e.storage().instance().get(&DataKey::TokenA).unwrap()
}

fn token_b(e: &Env) -> Address {
    e.storage().instance().get(&DataKey::TokenB).unwrap()
}

fn params(e: &Env) -> FxParams {
    e.storage().instance().get(&DataKey::Params).unwrap()
}

fn reserves(e: &Env) -> (i128, i128) {
    (get_i128(e, &DataKey::ReserveA), get_i128(e, &DataKey::ReserveB))
}

fn set_reserves(e: &Env, a: i128, b: i128) {
    e.storage().instance().set(&DataKey::ReserveA, &a);
    e.storage().instance().set(&DataKey::ReserveB, &b);
}

/// Reserves, lowered to the real balances if the pool lost tokens (issuer clawback), so the
/// next LP out is not paid from stale reserves at the expense of the others.
fn effective_reserves(e: &Env) -> (i128, i128) {
    let (ra, rb) = reserves(e);
    let me = e.current_contract_address();
    let ba = TokenClient::new(e, &token_a(e)).balance(&me);
    let bb = TokenClient::new(e, &token_b(e)).balance(&me);
    if ba < ra || bb < rb {
        let (na, nb) = (ra.min(ba), rb.min(bb));
        set_reserves(e, na, nb);
        (na, nb)
    } else {
        (ra, rb)
    }
}

fn bump(e: &Env) {
    e.storage().instance().extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);
}

fn require_admin(e: &Env, caller: &Address) {
    caller.require_auth();
    let admin: Address = e.storage().instance().get(&DataKey::Admin).unwrap();
    if admin != *caller {
        panic_with_error!(e, FxPoolError::Unauthorized);
    }
}

fn outflow_cap(e: &Env) -> OutflowCap {
    e.storage()
        .instance()
        .get(&DataKey::OutflowCap)
        .unwrap_or(OutflowCap { cap_bps: DEFAULT_CAP_BPS, window: DEFAULT_CAP_WINDOW })
}

fn validate_cap(e: &Env, c: &OutflowCap) {
    if c.cap_bps == 0 || c.cap_bps as i128 > BPS || c.window < MIN_CAP_WINDOW || c.window > MAX_CAP_WINDOW {
        panic_with_error!(e, FxPoolError::InvalidParams);
    }
}

/// The flow window as of now: the stored one while it lasts, else a fresh one based on the
/// given (current) reserves.
fn current_flow(e: &Env, ra: i128, rb: i128) -> FlowWindow {
    let now = e.ledger().timestamp();
    let window = outflow_cap(e).window;
    match e.storage().instance().get::<_, FlowWindow>(&DataKey::Flow) {
        Some(w) if now < w.start.saturating_add(window) => w,
        _ => FlowWindow { start: now, base_a: ra, base_b: rb, net_out_a: 0, net_out_b: 0 },
    }
}

/// Add one swap to the window; reverts if the outgoing token's net outflow exceeds the cap,
/// i.e. `cap_bps` of min(reserve at window start, reserve now). The min means a big LP exit
/// shrinks the allowance with the pool, while deposits never raise it mid-window.
fn add_flow(e: &Env, mut w: FlowWindow, a_in: bool, amount_in: i128, out: i128, r_out: i128) -> FlowWindow {
    let cap_bps = outflow_cap(e).cap_bps as i128;
    let (net_out, base) = if a_in {
        w.net_out_a -= amount_in;
        w.net_out_b += out;
        (w.net_out_b, w.base_b)
    } else {
        w.net_out_b -= amount_in;
        w.net_out_a += out;
        (w.net_out_a, w.base_a)
    };
    if net_out > mul_div_floor(e, &base.min(r_out), &cap_bps, &BPS) {
        panic_with_error!(e, FxPoolError::OutflowCapExceeded);
    }
    w
}

fn validate_params(e: &Env, p: &FxParams) {
    if p.base_fee_bps == 0 || p.base_fee_bps > p.max_fee_bps || p.max_fee_bps > MAX_FEE_CAP {
        panic_with_error!(e, FxPoolError::InvalidFee);
    }
    if p.amp > MAX_AMP
        || p.vol_mult > 10_000
        || p.max_dev_bps == 0
        || p.max_dev_bps > 10_000
        || p.max_age == 0
        || p.max_age > 86_400
        || p.history == 0
        || p.history > MAX_HISTORY
        || p.min_price <= 0
        || p.min_price >= p.max_price
    {
        panic_with_error!(e, FxPoolError::InvalidParams);
    }
}

/// `amp` may at most double or halve; 0 ↔ amp only for amp ≤ AMP_FROM_ZERO_MAX.
fn amp_step_ok(old: u32, new: u32) -> bool {
    if old == 0 || new == 0 {
        old.max(new) <= AMP_FROM_ZERO_MAX
    } else {
        new as u64 <= 2 * old as u64 && 2 * new as u64 >= old as u64
    }
}

/// Burn LP shares without a second `require_auth` (the caller already authorized the withdraw).
/// v4: emits the SEP-41 `burn` event, as `mint` already did (wallets and indexers track LP
/// supply from these events; same as our cp pool since its v3).
fn burn_shares(e: &Env, from: &Address, amount: i128) {
    Base::update(e, Some(from), None, amount);
    decrease_total_supply(e, amount);
    emit_burn(e, from, amount);
}

// ---------------------------------------------------------------- oracle

/// Oracle state for one swap: both prices (same decimals) and the fee to charge.
struct OracleState {
    p_a: i128,
    p_b: i128,
    /// 1.0 in the oracle's decimals (the price of the base asset).
    one: i128,
    fee_bps: u32,
}

impl OracleState {
    fn price_scaled(&self, e: &Env) -> i128 {
        mul_div_floor(e, &self.p_a, &PRICE_SCALE, &self.p_b)
    }
}

/// Latest record of `asset` in the oracle's base, checked for price > 0, age and future
/// skew. None for the base asset, which is exactly 1 (not every SEP-40 oracle quotes its own
/// base, so we never ask).
fn latest(e: &Env, oracle: &OracleClient, base: &Asset, asset: &Asset, max_age: u64) -> Option<PriceData> {
    if asset == base {
        return None;
    }
    Some(checked_lastprice(e, oracle, asset, max_age))
}

/// `lastprice(asset)`, checked for price > 0, age and future skew.
fn checked_lastprice(e: &Env, oracle: &OracleClient, asset: &Asset, max_age: u64) -> PriceData {
    let pd = oracle.lastprice(asset).unwrap_or_else(|| panic_with_error!(e, FxPoolError::PriceMissing));
    if pd.price <= 0 {
        panic_with_error!(e, FxPoolError::PriceMissing);
    }
    let now = e.ledger().timestamp();
    if pd.timestamp > now.saturating_add(MAX_FUTURE_SKEW) {
        panic_with_error!(e, FxPoolError::FutureTimestamp);
    }
    if now.saturating_sub(pd.timestamp) > max_age {
        panic_with_error!(e, FxPoolError::StalePrice);
    }
    pd
}

/// v3 depeg guard: each configured token's market price (peg oracle) must be within
/// `max_dev_bps` of its fiat reference (main feed). No guard configured = v2 behaviour.
fn check_peg(e: &Env, os: &OracleState) {
    let st = e.storage().instance();
    let Some(g) = st.get::<_, PegGuard>(&DataKey::PegGuard) else {
        return;
    };
    let peg = OracleClient::new(e, &g.oracle);
    let peg_decimals: u32 = st.get(&DataKey::PegDecimals).unwrap();
    if peg.decimals() != peg_decimals {
        panic_with_error!(e, FxPoolError::OracleChanged);
    }
    let i = |v: i128| I256::from_i128(e, v);
    let peg_one = i(10i128.pow(peg_decimals));
    for (asset, fiat) in [(g.asset_a, os.p_a), (g.asset_b, os.p_b)] {
        if let PegAsset::Asset(asset) = asset {
            let market = checked_lastprice(e, &peg, &asset, g.max_age).price;
            // Compare market / peg_one with fiat / one, cross-multiplied (no rounding).
            let m = i(market).mul(&i(os.one));
            let f = i(fiat).mul(&peg_one);
            let diff = if m > f { m.sub(&f) } else { f.sub(&m) };
            if diff.mul(&i(BPS)) > f.mul(&i(g.max_dev_bps as i128)) {
                panic_with_error!(e, FxPoolError::Depegged);
            }
        }
    }
}

/// Records *before* the latest one for `asset`, newest first; None for the base asset.
/// We ask for history + 1 and drop the first (= `lastprice`), so the circuit breaker compares
/// the latest price against a mean it is not part of. Reflector returns n + 1 records for n,
/// SEP-40 says n; any length is accepted (`mean_cross_rate` takes at most `history` of them).
fn prior_history(e: &Env, oracle: &OracleClient, base: &Asset, asset: &Asset, history: u32) -> Option<Vec<PriceData>> {
    if asset == base {
        return None;
    }
    let h = oracle.prices(asset, &(history + 1)).unwrap_or_else(|| panic_with_error!(e, FxPoolError::PriceMissing));
    if h.len() < 2 {
        panic_with_error!(e, FxPoolError::PriceMissing);
    }
    Some(h.slice(1..h.len()))
}

/// Mean of the cross rate A/B (scaled by PRICE_SCALE) over at most `n` prior records.
/// For two non-base assets, records are matched by timestamp (Reflector aligns them to its
/// resolution grid).
fn mean_cross_rate(e: &Env, ha: &Option<Vec<PriceData>>, hb: &Option<Vec<PriceData>>, one: i128, n: u32) -> i128 {
    let mut sum: i128 = 0;
    let mut count: u32 = 0;
    let mut add = |pa: i128, pb: i128| {
        if count < n && pa > 0 && pb > 0 {
            sum += mul_div_floor(e, &pa, &PRICE_SCALE, &pb);
            count += 1;
        }
    };
    match (ha, hb) {
        (Some(a), None) => a.iter().for_each(|r| add(r.price, one)),
        (None, Some(b)) => b.iter().for_each(|r| add(one, r.price)),
        (Some(a), Some(b)) => {
            for ra in a.iter() {
                if let Some(rb) = b.iter().find(|rb| rb.timestamp == ra.timestamp) {
                    add(ra.price, rb.price);
                }
            }
        }
        (None, None) => add(one, one),
    }
    if count == 0 {
        panic_with_error!(e, FxPoolError::PriceMissing);
    }
    sum / count as i128
}

/// Read and check the oracle: band, freshness, circuit breaker, dynamic fee.
fn oracle_state(e: &Env, p: &FxParams) -> OracleState {
    let st = e.storage().instance();
    let oracle = OracleClient::new(e, &st.get::<_, Address>(&DataKey::Oracle).unwrap());
    // Re-read decimals every time: a feed that silently rescaled its prices would otherwise
    // mis-price everything by powers of ten.
    let decimals = oracle.decimals();
    if decimals != st.get::<_, u32>(&DataKey::OracleDecimals).unwrap() {
        panic_with_error!(e, FxPoolError::OracleChanged);
    }
    let one = 10i128.pow(decimals);
    let resolution: u64 = st.get(&DataKey::OracleResolution).unwrap();
    let base: Asset = st.get(&DataKey::OracleBase).unwrap();
    let asset_a: Asset = st.get(&DataKey::AssetA).unwrap();
    let asset_b: Asset = st.get(&DataKey::AssetB).unwrap();

    let la = latest(e, &oracle, &base, &asset_a, p.max_age);
    let lb = latest(e, &oracle, &base, &asset_b, p.max_age);
    let now = e.ledger().timestamp();
    let (p_a, p_b, oldest) = match (&la, &lb) {
        (Some(a), Some(b)) => {
            if a.timestamp.abs_diff(b.timestamp) > resolution {
                panic_with_error!(e, FxPoolError::PriceSkew);
            }
            (a.price, b.price, a.timestamp.min(b.timestamp))
        }
        (Some(a), None) => (a.price, one, a.timestamp),
        (None, Some(b)) => (one, b.price, b.timestamp),
        (None, None) => (one, one, now), // unreachable: constructor rejects asset_a == asset_b
    };

    let spot = mul_div_floor(e, &p_a, &PRICE_SCALE, &p_b);
    if spot < p.min_price || spot > p.max_price {
        panic_with_error!(e, FxPoolError::PriceOutOfBand);
    }

    let ha = prior_history(e, &oracle, &base, &asset_a, p.history);
    let hb = prior_history(e, &oracle, &base, &asset_b, p.history);
    let mean = mean_cross_rate(e, &ha, &hb, one, p.history);
    let dev_ppm = mul_div_floor(e, &(spot - mean).abs(), &PPM, &mean);
    if dev_ppm > p.max_dev_bps as i128 * 100 {
        panic_with_error!(e, FxPoolError::PriceUnstable);
    }
    // In hundredths of a bps: base + vol_mult·dev_bps + base·age/resolution.
    // dev_ppm ≤ 1e8 and age ≤ 86 400 here, so the products are small.
    let age = now.saturating_sub(oldest) as i128;
    let base_c = p.base_fee_bps as i128 * 100;
    let fee_c = base_c + p.vol_mult as i128 * dev_ppm + base_c * age / resolution as i128;
    let fee_bps = (fee_c / 100).min(p.max_fee_bps as i128) as u32;
    OracleState { p_a, p_b, one, fee_bps }
}

/// Price an exact-input swap and check it against the oracle(s) and the outflow cap.
/// Returns (amount_out, a_in?, oracle state, flow window including this swap — the caller
/// stores it if the swap goes through).
fn price_swap(e: &Env, token_in: &Address, amount_in: i128) -> (i128, bool, OracleState, FlowWindow) {
    if amount_in <= 0 {
        panic_with_error!(e, FxPoolError::InvalidAmount);
    }
    let a_in = if *token_in == token_a(e) {
        true
    } else if *token_in == token_b(e) {
        false
    } else {
        panic_with_error!(e, FxPoolError::InvalidToken)
    };
    let (ra, rb) = reserves(e);
    if ra <= 0 || rb <= 0 {
        panic_with_error!(e, FxPoolError::InsufficientLiquidity);
    }
    let p = params(e);
    let os = oracle_state(e, &p);
    check_peg(e, &os);
    let net_in = mul_div_floor(e, &amount_in, &(BPS - os.fee_bps as i128), &BPS);
    let out = if a_in {
        curve_out(e, net_in, ra, rb, os.p_a, os.p_b, p.amp)
    } else {
        curve_out(e, net_in, rb, ra, os.p_b, os.p_a, p.amp)
    };
    // The virtual liquidity makes the curve deeper than the real reserves: never pay out
    // more than the pool really holds.
    let r_out = if a_in { rb } else { ra };
    if out >= r_out {
        panic_with_error!(e, FxPoolError::InsufficientLiquidity);
    }
    let flow = add_flow(e, current_flow(e, ra, rb), a_in, amount_in, out, r_out);
    (out, a_in, os, flow)
}

fn balance(e: &Env, token: &Address) -> i128 {
    TokenClient::new(e, token).balance(&e.current_contract_address())
}

/// Amounts to take for a deposit offering up to `desired_*`. Returns
/// (supply, reserve_a, reserve_b, amount_a, amount_b); reserves are 0 for the first deposit.
fn plan_deposit(e: &Env, desired_a: i128, desired_b: i128, min_a: i128, min_b: i128) -> (i128, i128, i128, i128, i128) {
    if desired_a <= 0 || desired_b <= 0 || min_a < 0 || min_b < 0 {
        panic_with_error!(e, FxPoolError::InvalidAmount);
    }
    // Branch on LP supply, not reserves, so a donation cannot pre-set the first price.
    let supply = TotalSupply::total_supply(e);
    let (ra, rb) = if supply == 0 { (0, 0) } else { effective_reserves(e) };
    let (amount_a, amount_b) = if supply == 0 {
        (desired_a, desired_b)
    } else {
        let optimal_b = mul_div_floor(e, &desired_a, &rb, &ra);
        if optimal_b <= desired_b {
            (desired_a, optimal_b)
        } else {
            (mul_div_floor(e, &desired_b, &ra, &rb), desired_b)
        }
    };
    if amount_a < min_a {
        panic_with_error!(e, FxPoolError::SlippageA);
    }
    if amount_b < min_b {
        panic_with_error!(e, FxPoolError::SlippageB);
    }
    (supply, ra, rb, amount_a, amount_b)
}

/// Mint shares for amounts already received and update reserves. Returns the shares.
fn finish_deposit(e: &Env, to: &Address, supply: i128, ra: i128, rb: i128, amount_a: i128, amount_b: i128) -> i128 {
    let shares = if supply == 0 {
        let root = isqrt(e, &I256::from_i128(e, amount_a).mul(&I256::from_i128(e, amount_b)));
        if root <= MINIMUM_LIQUIDITY {
            panic_with_error!(e, FxPoolError::InsufficientLiquidity);
        }
        TotalSupply::mint(e, &e.current_contract_address(), MINIMUM_LIQUIDITY);
        root - MINIMUM_LIQUIDITY
    } else {
        let by_a = mul_div_floor(e, &amount_a, &supply, &ra);
        let by_b = mul_div_floor(e, &amount_b, &supply, &rb);
        by_a.min(by_b)
    };
    if shares <= 0 {
        panic_with_error!(e, FxPoolError::InsufficientLiquidity);
    }
    TotalSupply::mint(e, to, shares);
    set_reserves(e, ra + amount_a, rb + amount_b);
    Deposit { provider: to.clone(), amount_a, amount_b, shares }.publish(e);
    shares
}

#[contract]
pub struct LimeFxPool;

#[contractimpl]
impl LimeFxPool {
    /// Tokens must be sorted (token_a < token_b); `asset_a` / `asset_b` are their oracle assets
    /// (e.g. EURC ↔ Other("EUR"), USDC ↔ Other("USD")). `min_price` / `max_price` is the hard
    /// band for the price of A in B, scaled by PRICE_SCALE (e.g. 0.9–1.4 for EUR/USD).
    #[allow(clippy::too_many_arguments)]
    pub fn __constructor(
        e: &Env,
        admin: Address,
        token_a: Address,
        token_b: Address,
        oracle: Address,
        asset_a: Asset,
        asset_b: Asset,
        base_fee_bps: u32,
        amp: u32,
        min_price: i128,
        max_price: i128,
    ) {
        if token_a >= token_b {
            panic_with_error!(e, FxPoolError::SameToken);
        }
        if asset_a == asset_b {
            panic_with_error!(e, FxPoolError::SameAsset);
        }
        let decimals = TokenClient::new(e, &token_a).decimals();
        if TokenClient::new(e, &token_b).decimals() != decimals {
            panic_with_error!(e, FxPoolError::DecimalsMismatch);
        }
        let oc = OracleClient::new(e, &oracle);
        let oracle_decimals = oc.decimals();
        if oracle_decimals > 18 {
            panic_with_error!(e, FxPoolError::InvalidParams);
        }
        let reported = oc.resolution() as u64;
        let resolution = if reported > 0 { reported } else { DEFAULT_RESOLUTION };
        let params = FxParams {
            amp,
            base_fee_bps,
            max_fee_bps: base_fee_bps.max(100),
            vol_mult: 2,
            max_dev_bps: 200,
            // One round plus 60 s for the update transaction to land (360 s on Reflector);
            // 900 s if the oracle reports no resolution. The age surcharge covers the rest.
            max_age: if reported > 0 { reported + 60 } else { 900 },
            history: 6,
            min_price,
            max_price,
        };
        validate_params(e, &params);
        let st = e.storage().instance();
        st.set(&DataKey::Admin, &admin);
        st.set(&DataKey::TokenA, &token_a);
        st.set(&DataKey::TokenB, &token_b);
        st.set(&DataKey::Oracle, &oracle);
        st.set(&DataKey::AssetA, &asset_a);
        st.set(&DataKey::AssetB, &asset_b);
        st.set(&DataKey::OracleBase, &oc.base());
        st.set(&DataKey::OracleDecimals, &oracle_decimals);
        st.set(&DataKey::OracleResolution, &resolution);
        st.set(&DataKey::Params, &params);
        Base::set_metadata(e, decimals, String::from_str(e, "LimeFX LP"), String::from_str(e, "LFXLP"));
    }

    // ---------------------------------------------------------------- liquidity
    //
    // Proportional-only on purpose. A value-based single-sided deposit ("deposit 1000 EURC, get
    // shares worth 1000 EURC at the oracle price") would let anyone swap at the oracle price
    // with no fee: deposit A single-sided, withdraw proportionally in A+B. That is a fee-free
    // oracle-arbitrage path straight out of the LPs' pockets, so the pool never values a
    // deposit at the oracle price; it only accepts the current reserve ratio.

    /// Add liquidity at the current reserve ratio. Takes at most `desired_*`, at least `min_*`.
    /// Returns (amount_a, amount_b, shares minted).
    #[when_not_paused]
    pub fn deposit(e: &Env, from: Address, desired_a: i128, desired_b: i128, min_a: i128, min_b: i128) -> (i128, i128, i128) {
        from.require_auth();
        bump(e);
        let (supply, ra, rb, amount_a, amount_b) = plan_deposit(e, desired_a, desired_b, min_a, min_b);
        let me = e.current_contract_address();
        TokenClient::new(e, &token_a(e)).transfer(&from, &me, &amount_a);
        TokenClient::new(e, &token_b(e)).transfer(&from, &me, &amount_b);
        let shares = finish_deposit(e, &from, supply, ra, rb, amount_a, amount_b);
        (amount_a, amount_b, shares)
    }

    /// Low-level deposit for routers: both tokens must already be in the pool. Everything
    /// above the reserves counts as offered; the pool keeps what matches its ratio, refunds the
    /// rest to `to` and mints the shares to `to`. The user signs fixed-amount transfers, so the
    /// auth cannot go stale when reserves move. Must run in the same transaction as the
    /// transfers (a router call): tokens left in the pool can be claimed by anyone.
    #[when_not_paused]
    pub fn deposit_raw(e: &Env, to: Address, min_a: i128, min_b: i128) -> (i128, i128, i128) {
        bump(e);
        let me = e.current_contract_address();
        if to == me {
            panic_with_error!(e, FxPoolError::InvalidToken);
        }
        let (ra, rb) = effective_reserves(e);
        let (offered_a, offered_b) = (balance(e, &token_a(e)) - ra, balance(e, &token_b(e)) - rb);
        let (supply, ra, rb, amount_a, amount_b) = plan_deposit(e, offered_a, offered_b, min_a, min_b);
        if offered_a > amount_a {
            TokenClient::new(e, &token_a(e)).transfer(&me, &to, &(offered_a - amount_a));
        }
        if offered_b > amount_b {
            TokenClient::new(e, &token_b(e)).transfer(&me, &to, &(offered_b - amount_b));
        }
        let shares = finish_deposit(e, &to, supply, ra, rb, amount_a, amount_b);
        (amount_a, amount_b, shares)
    }

    /// Burn `shares` for the pro-rata part of both reserves. Works while paused and never
    /// touches the oracle, so LPs can always exit (even if the oracle is dead or unstable).
    pub fn withdraw(e: &Env, from: Address, shares: i128, min_a: i128, min_b: i128) -> (i128, i128) {
        from.require_auth();
        bump(e);
        if shares <= 0 {
            panic_with_error!(e, FxPoolError::InvalidAmount);
        }
        if Base::balance(e, &from) < shares {
            panic_with_error!(e, FxPoolError::InsufficientShares);
        }
        let (ra, rb) = effective_reserves(e);
        let supply = TotalSupply::total_supply(e);
        let amount_a = mul_div_floor(e, &shares, &ra, &supply);
        let amount_b = mul_div_floor(e, &shares, &rb, &supply);
        if amount_a < min_a {
            panic_with_error!(e, FxPoolError::SlippageA);
        }
        if amount_b < min_b {
            panic_with_error!(e, FxPoolError::SlippageB);
        }
        if amount_a <= 0 && amount_b <= 0 {
            panic_with_error!(e, FxPoolError::InsufficientLiquidity);
        }
        burn_shares(e, &from, shares);
        let me = e.current_contract_address();
        if amount_a > 0 {
            TokenClient::new(e, &token_a(e)).transfer(&me, &from, &amount_a);
        }
        if amount_b > 0 {
            TokenClient::new(e, &token_b(e)).transfer(&me, &from, &amount_b);
        }
        set_reserves(e, ra - amount_a, rb - amount_b);
        Withdraw { provider: from, amount_a, amount_b, shares }.publish(e);
        (amount_a, amount_b)
    }

    // ---------------------------------------------------------------- swaps

    /// Exact-input swap: pull `amount_in` of `token_in` from `from`, send the output to `to`.
    #[when_not_paused]
    pub fn swap(e: &Env, from: Address, to: Address, token_in: Address, amount_in: i128, min_out: i128) -> i128 {
        from.require_auth();
        bump(e);
        // Clawback-safe: price against what the pool really holds.
        let (ra, rb) = effective_reserves(e);
        let (out, a_in, os, flow) = price_swap(e, &token_in, amount_in);
        if out <= 0 || out < min_out {
            panic_with_error!(e, FxPoolError::InsufficientOutput);
        }
        e.storage().instance().set(&DataKey::Flow, &flow);
        let me = e.current_contract_address();
        TokenClient::new(e, &token_in).transfer(&from, &me, &amount_in);
        let (token_out, in_a, in_b, out_a, out_b, new_a, new_b) = if a_in {
            (token_b(e), amount_in, 0, 0, out, ra + amount_in, rb - out)
        } else {
            (token_a(e), 0, amount_in, out, 0, ra - out, rb + amount_in)
        };
        TokenClient::new(e, &token_out).transfer(&me, &to, &out);
        set_reserves(e, new_a, new_b);
        Swap { from, to, in_a, in_b, out_a, out_b, fee_bps: os.fee_bps, oracle_price: os.price_scaled(e) }
            .publish(e);
        out
    }

    /// Low-level exact-input swap for routers: `token_in` must already have been sent to the
    /// pool; everything above its reserve is the input. Pays the output to `to` and returns it.
    /// Same pricing, checks and event as `swap` (the event's `from` is `to`). Must run in the
    /// same transaction as the transfer in (a router call), like the cp pool's `swap_raw`.
    #[when_not_paused]
    pub fn swap_in(e: &Env, token_in: Address, min_out: i128, to: Address) -> i128 {
        bump(e);
        let me = e.current_contract_address();
        if to == me || to == token_a(e) || to == token_b(e) {
            panic_with_error!(e, FxPoolError::InvalidToken);
        }
        let (ra, rb) = effective_reserves(e);
        let r_in = if token_in == token_a(e) {
            ra
        } else if token_in == token_b(e) {
            rb
        } else {
            panic_with_error!(e, FxPoolError::InvalidToken)
        };
        let amount_in = balance(e, &token_in) - r_in;
        let (out, a_in, os, flow) = price_swap(e, &token_in, amount_in);
        if out <= 0 || out < min_out {
            panic_with_error!(e, FxPoolError::InsufficientOutput);
        }
        e.storage().instance().set(&DataKey::Flow, &flow);
        let (token_out, in_a, in_b, out_a, out_b, new_a, new_b) = if a_in {
            (token_b(e), amount_in, 0, 0, out, ra + amount_in, rb - out)
        } else {
            (token_a(e), 0, amount_in, out, 0, ra - out, rb + amount_in)
        };
        TokenClient::new(e, &token_out).transfer(&me, &to, &out);
        set_reserves(e, new_a, new_b);
        Swap { from: to.clone(), to, in_a, in_b, out_a, out_b, fee_bps: os.fee_bps, oracle_price: os.price_scaled(e) }
            .publish(e);
        out
    }

    /// Quote an exact-input swap now: amount out, fee charged (bps), oracle price of A in B
    /// (scaled by PRICE_SCALE). Reverts exactly when `swap` would (paused, stale/unstable or
    /// out-of-band oracle, depeg, outflow cap, …).
    #[when_not_paused]
    pub fn quote(e: &Env, token_in: Address, amount_in: i128) -> Quote {
        let (amount_out, _, os, _) = price_swap(e, &token_in, amount_in);
        Quote { amount_out, fee_bps: os.fee_bps, oracle_price: os.price_scaled(e) }
    }

    // ---------------------------------------------------------------- views

    pub fn info(e: &Env) -> FxInfo {
        let st = e.storage().instance();
        let (reserve_a, reserve_b) = reserves(e);
        FxInfo {
            token_a: token_a(e),
            token_b: token_b(e),
            reserve_a,
            reserve_b,
            total_shares: TotalSupply::total_supply(e),
            oracle: st.get(&DataKey::Oracle).unwrap(),
            asset_a: st.get(&DataKey::AssetA).unwrap(),
            asset_b: st.get(&DataKey::AssetB).unwrap(),
            params: params(e),
        }
    }

    pub fn version(_e: &Env) -> u32 {
        VERSION
    }

    /// v3: the outflow cap in force (defaults until the admin sets one).
    pub fn outflow_cap(e: &Env) -> OutflowCap {
        outflow_cap(e)
    }

    /// v3: swap flow in the current window, as the next swap would see it.
    pub fn flow(e: &Env) -> FlowWindow {
        let (ra, rb) = reserves(e);
        current_flow(e, ra, rb)
    }

    /// v3: the depeg guard, if configured.
    pub fn peg_guard(e: &Env) -> Option<PegGuard> {
        e.storage().instance().get(&DataKey::PegGuard)
    }

    /// (token_a, token_b), sorted. Same call as on LimeSwap pools, so routers can check a pair.
    pub fn tokens(e: &Env) -> (Address, Address) {
        (token_a(e), token_b(e))
    }

    /// Lower the reserves to what the pool really holds (after an issuer clawback). Never raises
    /// them. Routers call it before sending tokens in: once the user's input is in the pool it
    /// would hide the shortfall, and the raw entry points would charge the user for it.
    pub fn reconcile(e: &Env) -> (i128, i128) {
        bump(e);
        effective_reserves(e)
    }

    /// Send tokens above the recorded reserves (donations, mistaken transfers) to `to`.
    pub fn skim(e: &Env, to: Address) {
        let (ra, rb) = reserves(e);
        let me = e.current_contract_address();
        for (token, r) in [(token_a(e), ra), (token_b(e), rb)] {
            let c = TokenClient::new(e, &token);
            let bal = c.balance(&me);
            if bal > r {
                c.transfer(&me, &to, &(bal - r));
            }
        }
    }

    // ---------------------------------------------------------------- admin

    pub fn admin(e: &Env) -> Address {
        e.storage().instance().get(&DataKey::Admin).unwrap()
    }

    /// Fees, breaker, age and band change freely within bounds. `amp` is rate-limited: at most
    /// ×2 / ÷2 per change (0 ↔ ≤ 10), and one change per 24 h. Changing the curve shape moves
    /// the marginal price of a skewed pool, so a big instant jump would hand LP value to the
    /// next trader (or to an admin who trades right after).
    pub fn set_params(e: &Env, caller: Address, params: FxParams) {
        require_admin(e, &caller);
        bump(e);
        validate_params(e, &params);
        let old_amp = self::params(e).amp;
        if params.amp != old_amp {
            if !amp_step_ok(old_amp, params.amp) {
                panic_with_error!(e, FxPoolError::AmpChangeTooLarge);
            }
            let now = e.ledger().timestamp();
            if let Some(last) = e.storage().instance().get::<_, u64>(&DataKey::AmpChangedAt) {
                if now < last + AMP_CHANGE_DELAY {
                    panic_with_error!(e, FxPoolError::AmpChangeTooFast);
                }
            }
            e.storage().instance().set(&DataKey::AmpChangedAt, &now);
        }
        e.storage().instance().set(&DataKey::Params, &params);
        ParamsSet { params }.publish(e);
    }

    /// v3: max net outflow per token through swaps per window. Takes effect immediately (the
    /// running window keeps its start and counters).
    pub fn set_outflow_cap(e: &Env, caller: Address, cap: OutflowCap) {
        require_admin(e, &caller);
        bump(e);
        validate_cap(e, &cap);
        e.storage().instance().set(&DataKey::OutflowCap, &cap);
        OutflowCapSet { cap }.publish(e);
    }

    /// v3: configure (Some) or remove (None) the depeg guard. The peg oracle must quote in the
    /// same base as the main feed, and must not be asked for its own base asset.
    pub fn set_peg_guard(e: &Env, caller: Address, guard: Option<PegGuard>) {
        require_admin(e, &caller);
        bump(e);
        let st = e.storage().instance();
        match &guard {
            None => {
                st.remove(&DataKey::PegGuard);
                st.remove(&DataKey::PegDecimals);
            }
            Some(g) => {
                if g.max_dev_bps == 0 || g.max_dev_bps > 5_000 || g.max_age == 0 || g.max_age > 86_400 {
                    panic_with_error!(e, FxPoolError::InvalidParams);
                }
                if g.asset_a == PegAsset::Unchecked && g.asset_b == PegAsset::Unchecked {
                    panic_with_error!(e, FxPoolError::InvalidParams);
                }
                let peg = OracleClient::new(e, &g.oracle);
                let base = peg.base();
                let base_ref = PegAsset::Asset(base.clone());
                if base != st.get::<_, Asset>(&DataKey::OracleBase).unwrap()
                    || g.asset_a == base_ref
                    || g.asset_b == base_ref
                {
                    panic_with_error!(e, FxPoolError::InvalidParams);
                }
                let decimals = peg.decimals();
                if decimals > 18 {
                    panic_with_error!(e, FxPoolError::InvalidParams);
                }
                st.set(&DataKey::PegGuard, g);
                st.set(&DataKey::PegDecimals, &decimals);
            }
        }
        let (oracle, max_dev_bps) = match guard {
            Some(g) => (Some(g.oracle), g.max_dev_bps),
            None => (None, 0),
        };
        PegGuardSet { oracle, max_dev_bps }.publish(e);
    }

    /// v3: step 1 of an admin transfer. The new admin must call `accept_admin`; until then the
    /// current admin keeps all rights and can overwrite the proposal (e.g. after a typo).
    pub fn propose_admin(e: &Env, caller: Address, new_admin: Address) {
        require_admin(e, &caller);
        bump(e);
        e.storage().instance().set(&DataKey::PendingAdmin, &new_admin);
        AdminProposed { current: caller, pending: new_admin }.publish(e);
    }

    /// v3: step 2: the proposed admin takes over (a timelock does this via an executed operation).
    pub fn accept_admin(e: &Env, new_admin: Address) {
        new_admin.require_auth();
        bump(e);
        let st = e.storage().instance();
        if st.get::<_, Address>(&DataKey::PendingAdmin) != Some(new_admin.clone()) {
            panic_with_error!(e, FxPoolError::Unauthorized);
        }
        let previous: Address = st.get(&DataKey::Admin).unwrap();
        st.set(&DataKey::Admin, &new_admin);
        st.remove(&DataKey::PendingAdmin);
        AdminChanged { previous, admin: new_admin }.publish(e);
    }

    pub fn pending_admin(e: &Env) -> Option<Address> {
        e.storage().instance().get(&DataKey::PendingAdmin)
    }

    /// v3: the guardian may only `pause` (instant emergency brake). None removes it.
    pub fn set_guardian(e: &Env, caller: Address, guardian: Option<Address>) {
        require_admin(e, &caller);
        bump(e);
        match &guardian {
            Some(g) => e.storage().instance().set(&DataKey::Guardian, g),
            None => e.storage().instance().remove(&DataKey::Guardian),
        }
        GuardianSet { guardian }.publish(e);
    }

    pub fn guardian(e: &Env) -> Option<Address> {
        e.storage().instance().get(&DataKey::Guardian)
    }

    pub fn upgrade(e: &Env, caller: Address, new_wasm_hash: BytesN<32>) {
        require_admin(e, &caller);
        Upgraded { from_version: VERSION, new_wasm_hash: new_wasm_hash.clone() }.publish(e);
        upgradeable::upgrade(e, &new_wasm_hash);
    }
}

#[contractimpl]
impl Pausable for LimeFxPool {
    fn paused(e: &Env) -> bool {
        pausable::paused(e)
    }

    /// Admin or guardian (instant, for emergencies). Withdrawals keep working while paused.
    fn pause(e: &Env, caller: Address) {
        caller.require_auth();
        let st = e.storage().instance();
        let admin: Address = st.get(&DataKey::Admin).unwrap();
        if caller != admin && st.get::<_, Address>(&DataKey::Guardian) != Some(caller) {
            panic_with_error!(e, FxPoolError::Unauthorized);
        }
        pausable::pause(e);
    }

    fn unpause(e: &Env, caller: Address) {
        require_admin(e, &caller);
        pausable::unpause(e);
    }
}

#[contractimpl]
impl FungibleToken for LimeFxPool {
    type ContractType = Compose<(TotalSupply,)>;

    fn balance(e: &Env, account: Address) -> i128 {
        Self::ContractType::balance(e, &account)
    }

    fn allowance(e: &Env, owner: Address, spender: Address) -> i128 {
        Self::ContractType::allowance(e, &owner, &spender)
    }

    fn transfer(e: &Env, from: Address, to: MuxedAddress, amount: i128) {
        Self::ContractType::transfer(e, &from, &to, amount);
    }

    fn transfer_from(e: &Env, spender: Address, from: Address, to: Address, amount: i128) {
        Self::ContractType::transfer_from(e, &spender, &from, &to, amount);
    }

    fn approve(e: &Env, owner: Address, spender: Address, amount: i128, live_until_ledger: u32) {
        Self::ContractType::approve(e, &owner, &spender, amount, live_until_ledger);
    }

    fn decimals(e: &Env) -> u32 {
        Self::ContractType::decimals(e)
    }

    fn name(e: &Env) -> String {
        Self::ContractType::name(e)
    }

    fn symbol(e: &Env) -> String {
        Self::ContractType::symbol(e)
    }
}

#[contractimpl(contracttrait)]
impl FungibleTotalSupply for LimeFxPool {}
