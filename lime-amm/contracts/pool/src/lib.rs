#![no_std]
//! LimeSwap pool: constant-product (x·y=k) AMM for one token pair.
//!
//! - The LP share is a SEP-41 token (OpenZeppelin fungible + total supply) living in this contract.
//! - Settlement is pull-based (no callbacks; Soroban forbids reentrancy):
//!   * `swap` pulls `amount_in` from the trader and pays out.
//!   * `swap_raw` is the Uniswap-V2-style low-level swap for routers: the input must already
//!     have been sent to the pool; the pool checks the fee-adjusted invariant on balances.
//! - Price accumulators (Uniswap V2 style) + a small ring buffer of observations give an
//!   on-chain TWAP (`twap(window)`), so other contracts never need the manipulable spot price.
//! - Admin (the factory's admin at creation time) can pause swaps/deposits and upgrade. Withdrawals always work,
//!   so LPs can exit even while paused.
//! - v3 compliance mode for regulated Stellar assets (opt-in by the asset's issuer): LP shares
//!   follow the issuer's trustline authorization. A frozen holder can't move or receive shares,
//!   and if she withdraws, *both* sides are held as owed until she is unfrozen (paying out the
//!   free side would let her sell the frozen asset through the pool's own swaps). The issuer can
//!   `force_redeem` one holder's position, taking back only its own asset.
//! - v4 `deposit_raw` for routers: the user's signed transfers carry fixed amounts, and the
//!   pool refunds whatever does not match its ratio.
//! - v5 governance: two-step admin transfer (`propose_admin` + `accept_admin`) so the admin can
//!   move to a timelock without a typo bricking it, and an optional `guardian` that can only
//!   `pause` (instant emergency brake); `unpause`, `upgrade`, `migrate` stay with the admin.

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error,
    token::{StellarAssetClient, TokenClient}, Address, Executable, BytesN, Env, MuxedAddress, String, I256,
};
use stellar_contract_utils::math::{i128_fixed_point::mul_div_floor, i128_fixed_point::checked_mul_div_floor};
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
#[cfg(test)]
mod test_review;
#[cfg(test)]
mod test_compliance;
#[cfg(test)]
mod test_gov;

/// Bumped on every release.
pub const VERSION: u32 = 5;
/// Fee denominator: fees are in basis points.
pub const BPS: i128 = 10_000;
/// Shares burned forever on the first deposit (Uniswap V2), so the pool can never be emptied
/// to a state where one share is worth an absurd amount (share-inflation attack).
pub const MINIMUM_LIQUIDITY: i128 = 1_000;
/// Fixed-point scale of TWAP prices: 1.0 == 10^14.
pub const PRICE_SCALE: i128 = 100_000_000_000_000;
/// Ring buffer: one observation at most every OBS_PERIOD seconds, OBS_SLOTS kept
/// (≈ 2 hours of history at 5-minute spacing).
pub const OBS_PERIOD: u64 = 300;
pub const OBS_SLOTS: u32 = 24;
/// Largest price the TWAP records (≈ 10^12 when unscaled); keeps price·dt sums meaningful.
pub const PRICE_CAP: i128 = PRICE_SCALE * 1_000_000_000_000;

const DAY_IN_LEDGERS: u32 = 17_280;
const TTL_THRESHOLD: u32 = 7 * DAY_IN_LEDGERS;
const TTL_EXTEND_TO: u32 = 30 * DAY_IN_LEDGERS;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum PoolError {
    Unauthorized = 1,
    InvalidAmount = 2,
    InsufficientLiquidity = 3,
    InsufficientOutput = 4,
    SlippageA = 5,
    SlippageB = 6,
    KInvariant = 7,
    InvalidToken = 8,
    InvalidFee = 9,
    InsufficientShares = 10,
    NotEnoughHistory = 11,
    SameToken = 12,
    Overflow = 13,
    /// Compliance mode: this address is not authorized by the issuer of a regulated token.
    NotAuthorizedHolder = 14,
    /// Only the token's issuer (its Stellar Asset Contract admin) may do this.
    NotIssuer = 15,
    /// Compliance mode is not enabled for this token.
    NotRegulated = 16,
    /// LP shares can't be sent to the pool itself (they'd be locked forever).
    InvalidRecipient = 17,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Observation {
    pub timestamp: u64,
    /// Σ price_a·dt, price_a = reserve_b / reserve_a scaled by PRICE_SCALE (wrapping).
    pub cumulative_a: i128,
    /// Σ price_b·dt, price_b = reserve_a / reserve_b scaled by PRICE_SCALE (wrapping).
    pub cumulative_b: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PoolInfo {
    pub token_a: Address,
    pub token_b: Address,
    pub reserve_a: i128,
    pub reserve_b: i128,
    pub fee_bps: u32,
    pub total_shares: i128,
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Admin,
    TokenA,
    TokenB,
    FeeBps,
    ReserveA,
    ReserveB,
    /// Latest accumulator state (updated on every reserve change).
    Last,
    /// v1 only: ring buffer kept in instance storage. Removed by `migrate` (v2 uses ObsSlot).
    Obs,
    /// Index of the newest observation in the ring buffer.
    ObsHead,
    /// v2: number of filled ring-buffer slots, and one persistent entry per slot
    /// (so a swap loads one ~50-byte slot instead of the whole buffer).
    ObsLen,
    ObsSlot(u32),
    /// v2: tokens owed to an LP whose withdrawal transfer failed (e.g. the issuer deauthorized
    /// the pool or the LP). Kept out of reserves; claimable with `claim`.
    Owed(Address),
    OwedTotal,
    /// v3: compliance mode per side (token_a, token_b), switched on by that token's issuer.
    Regulated,
    /// v5: proposed new admin (two-step transfer) and the pause-only guardian.
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
    pub to: Address,
    pub in_a: i128,
    pub in_b: i128,
    pub out_a: i128,
    pub out_b: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Sync {
    pub reserve_a: i128,
    pub reserve_b: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Owed {
    #[topic]
    pub provider: Address,
    pub token: Address,
    pub amount: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Upgraded {
    pub from_version: u32,
    pub new_wasm_hash: BytesN<32>,
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
pub struct ComplianceSet {
    #[topic]
    pub token: Address,
    pub enabled: bool,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ForceRedeem {
    #[topic]
    pub holder: Address,
    #[topic]
    pub token: Address,
    pub shares: i128,
    /// Amount of the issuer's own token sent to `to` (incl. anything the holder was owed).
    pub seized: i128,
    pub to: Address,
    /// The holder's share of the other token, and whether it was paid out (else held as owed).
    pub other: i128,
    pub released: bool,
}

/// Constant-product output for an exact input, fee taken from the input.
/// out = (in·(1−f)·R_out) / (R_in + in·(1−f)) — same formula as CAP-38 classic pools.
pub fn amount_out(e: &Env, amount_in: i128, reserve_in: i128, reserve_out: i128, fee_bps: u32) -> i128 {
    if amount_in <= 0 {
        panic_with_error!(e, PoolError::InvalidAmount);
    }
    if reserve_in <= 0 || reserve_out <= 0 {
        panic_with_error!(e, PoolError::InsufficientLiquidity);
    }
    let in_with_fee = mul_div_floor(e, &amount_in, &(BPS - fee_bps as i128), &BPS);
    // R_in + in_with_fee cannot overflow for any realistic supply (both < 2^126).
    mul_div_floor(e, &in_with_fee, &reserve_out, &(reserve_in + in_with_fee))
}

/// Integer square root (floor).
fn isqrt(e: &Env, x: &I256) -> i128 {
    // Newton's method on I256; the result always fits i128 because x < 2^254.
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
    z.to_i128().unwrap_or_else(|| panic_with_error!(e, PoolError::Overflow))
}

fn get_i128(e: &Env, key: &DataKey) -> i128 {
    e.storage().instance().get(key).unwrap_or(0)
}

fn token_a(e: &Env) -> Address {
    e.storage().instance().get(&DataKey::TokenA).unwrap()
}

fn token_b(e: &Env) -> Address {
    e.storage().instance().get(&DataKey::TokenB).unwrap()
}

fn fee_bps(e: &Env) -> u32 {
    e.storage().instance().get(&DataKey::FeeBps).unwrap()
}

fn reserves(e: &Env) -> (i128, i128) {
    (get_i128(e, &DataKey::ReserveA), get_i128(e, &DataKey::ReserveB))
}

fn owed_total(e: &Env) -> (i128, i128) {
    e.storage().instance().get(&DataKey::OwedTotal).unwrap_or((0, 0))
}

/// Pool balances minus tokens already owed to LPs (those belong to nobody else).
fn balances(e: &Env) -> (i128, i128) {
    let me = e.current_contract_address();
    let (oa, ob) = owed_total(e);
    // Clamped: a clawback bigger than the reserves eats into owed funds; never go negative.
    (
        (TokenClient::new(e, &token_a(e)).balance(&me) - oa).max(0),
        (TokenClient::new(e, &token_b(e)).balance(&me) - ob).max(0),
    )
}

/// Reserves, lowered to the real balances if the pool lost tokens (issuer clawback).
/// Without this, the first LP to withdraw after a clawback would be paid from stale reserves
/// and push the whole loss onto the remaining LPs.
fn effective_reserves(e: &Env) -> (i128, i128) {
    let (ra, rb) = reserves(e);
    let (ba, bb) = balances(e);
    if ba < ra || bb < rb {
        let (na, nb) = (ra.min(ba), rb.min(bb));
        update(e, na, nb);
        (na, nb)
    } else {
        (ra, rb)
    }
}

/// Pay `amount` of `token` to `to`; if the transfer fails (e.g. deauthorized), record it as owed.
fn pay_or_owe(e: &Env, token: &Address, is_a: bool, to: &Address, amount: i128) -> bool {
    if amount <= 0 {
        return true;
    }
    let ok = matches!(
        TokenClient::new(e, token).try_transfer(&e.current_contract_address(), to, &amount),
        Ok(Ok(()))
    );
    if !ok {
        owe(e, token, is_a, to, amount);
    }
    ok
}

/// Record `amount` of `token` as owed to `to` (kept out of reserves, claimable with `claim`).
fn owe(e: &Env, token: &Address, is_a: bool, to: &Address, amount: i128) {
    if amount <= 0 {
        return;
    }
    let key = DataKey::Owed(to.clone());
    let (mut a, mut b): (i128, i128) = e.storage().persistent().get(&key).unwrap_or((0, 0));
    let (mut ta, mut tb) = owed_total(e);
    if is_a {
        a += amount;
        ta += amount;
    } else {
        b += amount;
        tb += amount;
    }
    e.storage().persistent().set(&key, &(a, b));
    e.storage().persistent().extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND_TO);
    e.storage().instance().set(&DataKey::OwedTotal, &(ta, tb));
    Owed { provider: to.clone(), token: token.clone(), amount }.publish(e);
}

fn regulated(e: &Env) -> (bool, bool) {
    e.storage().instance().get(&DataKey::Regulated).unwrap_or((false, false))
}

/// The SAC's own view of `who`: false when deauthorized or when there is no trustline at all.
/// (Only Stellar Asset Contracts reach this: `require_issuer` rejects every other token.)
fn sac_authorized(e: &Env, token: &Address, who: &Address) -> bool {
    matches!(StellarAssetClient::new(e, token).try_authorized(who), Ok(Ok(true)))
}

/// Compliance mode: `who` must be authorized by every regulated token's issuer. The pool's
/// own address (it holds the locked MINIMUM_LIQUIDITY) is exempt. Free when no side is regulated.
fn is_compliant(e: &Env, who: &Address) -> bool {
    let (reg_a, reg_b) = regulated(e);
    if !(reg_a || reg_b) || *who == e.current_contract_address() {
        return true;
    }
    !((reg_a && !sac_authorized(e, &token_a(e), who)) || (reg_b && !sac_authorized(e, &token_b(e), who)))
}

fn require_compliant(e: &Env, who: &Address) {
    if !is_compliant(e, who) {
        panic_with_error!(e, PoolError::NotAuthorizedHolder);
    }
}

/// LP shares may move between compliant holders only, and never into the pool itself.
fn check_share_transfer(e: &Env, from: &Address, to: &Address) {
    if *to == e.current_contract_address() {
        panic_with_error!(e, PoolError::InvalidRecipient);
    }
    require_compliant(e, from);
    require_compliant(e, to);
}

/// `token` must be one of the pool's tokens; returns (is_a, issuer) after the issuer's auth.
fn require_issuer(e: &Env, token: &Address) -> (bool, Address) {
    let is_a = if *token == token_a(e) {
        true
    } else if *token == token_b(e) {
        false
    } else {
        panic_with_error!(e, PoolError::InvalidToken)
    };
    // A custom token can have an `admin()` too; only a real SAC has issuer semantics.
    if token.executable() != Some(Executable::StellarAsset) {
        panic_with_error!(e, PoolError::NotIssuer);
    }
    let issuer = match StellarAssetClient::new(e, token).try_admin() {
        Ok(Ok(a)) => a,
        _ => panic_with_error!(e, PoolError::NotIssuer),
    };
    issuer.require_auth();
    (is_a, issuer)
}

fn bump(e: &Env) {
    e.storage().instance().extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);
}

fn require_admin(e: &Env, caller: &Address) {
    caller.require_auth();
    let admin: Address = e.storage().instance().get(&DataKey::Admin).unwrap();
    if admin != *caller {
        panic_with_error!(e, PoolError::Unauthorized);
    }
}

/// Price of one side in the other, scaled by PRICE_SCALE. Saturates at PRICE_CAP instead of
/// silently reading 0 when one reserve is astronomically larger than the other.
fn scaled_price(e: &Env, num: i128, den: i128) -> i128 {
    checked_mul_div_floor(e, &num, &PRICE_SCALE, &den).unwrap_or(PRICE_CAP).min(PRICE_CAP)
}

/// Accumulator state as of `now`, extrapolated from the last update with the current reserves.
fn current_observation(e: &Env) -> Observation {
    let now = e.ledger().timestamp();
    let last: Observation = e.storage().instance().get(&DataKey::Last).unwrap_or(Observation {
        timestamp: now,
        cumulative_a: 0,
        cumulative_b: 0,
    });
    let (ra, rb) = reserves(e);
    let dt = now.saturating_sub(last.timestamp) as i128;
    if dt == 0 || ra == 0 || rb == 0 {
        return Observation { timestamp: now, ..last };
    }
    // Wrapping arithmetic, as in Uniswap V2: consumers only ever use differences.
    Observation {
        timestamp: now,
        cumulative_a: last.cumulative_a.wrapping_add(scaled_price(e, rb, ra).wrapping_mul(dt)),
        cumulative_b: last.cumulative_b.wrapping_add(scaled_price(e, ra, rb).wrapping_mul(dt)),
    }
}

/// Write new reserves. Before that, roll the price accumulators forward with the OLD reserves
/// (so a price only counts for the time it actually stood) and maybe append to the ring buffer.
fn update(e: &Env, new_a: i128, new_b: i128) {
    let obs = current_observation(e);
    let st = e.storage().instance();
    st.set(&DataKey::Last, &obs);

    let len: u32 = st.get(&DataKey::ObsLen).unwrap_or(0);
    let head: u32 = st.get(&DataKey::ObsHead).unwrap_or(0);
    let due = len == 0
        || match e.storage().persistent().get::<_, Observation>(&DataKey::ObsSlot(head)) {
            None => true,
            Some(newest) => obs.timestamp >= newest.timestamp + OBS_PERIOD,
        };
    if due {
        let next = if len == 0 { 0 } else { (head + 1) % OBS_SLOTS };
        let key = DataKey::ObsSlot(next);
        e.storage().persistent().set(&key, &obs);
        e.storage().persistent().extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND_TO);
        st.set(&DataKey::ObsHead, &next);
        if len < OBS_SLOTS {
            st.set(&DataKey::ObsLen, &(len + 1));
        }
    }

    st.set(&DataKey::ReserveA, &new_a);
    st.set(&DataKey::ReserveB, &new_b);
    Sync { reserve_a: new_a, reserve_b: new_b }.publish(e);
}

/// Burn LP shares without a second `require_auth` (the caller already authorized the withdraw).
fn burn_shares(e: &Env, from: &Address, amount: i128) {
    Base::update(e, Some(from), None, amount);
    decrease_total_supply(e, amount);
    emit_burn(e, from, amount);
}

/// Amounts to take for a deposit offering up to `desired_*`. Returns
/// (supply, reserve_a, reserve_b, amount_a, amount_b); reserves are 0 for the first deposit.
fn plan_deposit(e: &Env, desired_a: i128, desired_b: i128, min_a: i128, min_b: i128) -> (i128, i128, i128, i128, i128) {
    if desired_a <= 0 || desired_b <= 0 || min_a < 0 || min_b < 0 {
        panic_with_error!(e, PoolError::InvalidAmount);
    }
    // Branch on LP supply, not reserves: nobody can pre-set the first depositor's price
    // with a donation (and `sync` refuses to run on an empty pool).
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
        panic_with_error!(e, PoolError::SlippageA);
    }
    if amount_b < min_b {
        panic_with_error!(e, PoolError::SlippageB);
    }
    (supply, ra, rb, amount_a, amount_b)
}

/// Mint shares for amounts already received and update reserves. Returns the shares.
fn finish_deposit(e: &Env, to: &Address, supply: i128, ra: i128, rb: i128, amount_a: i128, amount_b: i128) -> i128 {
    let shares = if supply == 0 {
        let product = I256::from_i128(e, amount_a).mul(&I256::from_i128(e, amount_b));
        let root = isqrt(e, &product);
        if root <= MINIMUM_LIQUIDITY {
            panic_with_error!(e, PoolError::InsufficientLiquidity);
        }
        // Locked forever: minted to the pool itself, which never transfers its own shares.
        TotalSupply::mint(e, &e.current_contract_address(), MINIMUM_LIQUIDITY);
        root - MINIMUM_LIQUIDITY
    } else {
        let by_a = mul_div_floor(e, &amount_a, &supply, &ra);
        let by_b = mul_div_floor(e, &amount_b, &supply, &rb);
        by_a.min(by_b)
    };
    if shares <= 0 {
        panic_with_error!(e, PoolError::InsufficientLiquidity);
    }
    TotalSupply::mint(e, to, shares);
    // First deposit via `deposit`: reserves = exactly what was deposited; any earlier donation
    // stays outside the reserves (anyone can `skim` it). Via `deposit_raw` a donation counts as
    // offered and goes to the first depositor (it can't be told apart from the user's transfer).
    update(e, ra + amount_a, rb + amount_b);
    Deposit { provider: to.clone(), amount_a, amount_b, shares }.publish(e);
    shares
}

#[contract]
pub struct LimeSwapPool;

#[contractimpl]
impl LimeSwapPool {
    /// Called by the factory. Tokens must be sorted (token_a < token_b).
    pub fn __constructor(e: &Env, admin: Address, token_a: Address, token_b: Address, fee_bps: u32) {
        if token_a >= token_b {
            panic_with_error!(e, PoolError::SameToken);
        }
        if fee_bps == 0 || fee_bps >= 1_000 {
            panic_with_error!(e, PoolError::InvalidFee);
        }
        let st = e.storage().instance();
        st.set(&DataKey::Admin, &admin);
        st.set(&DataKey::TokenA, &token_a);
        st.set(&DataKey::TokenB, &token_b);
        st.set(&DataKey::FeeBps, &fee_bps);
        Base::set_metadata(e, 7, String::from_str(e, "LimeSwap LP"), String::from_str(e, "LSLP"));
    }

    // ---------------------------------------------------------------- liquidity

    /// Add liquidity at the current ratio. Takes at most `desired_*`, at least `min_*`.
    /// Returns (amount_a, amount_b, shares minted).
    #[when_not_paused]
    pub fn deposit(
        e: &Env,
        from: Address,
        desired_a: i128,
        desired_b: i128,
        min_a: i128,
        min_b: i128,
    ) -> (i128, i128, i128) {
        from.require_auth();
        bump(e);
        require_compliant(e, &from);
        let (supply, ra, rb, amount_a, amount_b) = plan_deposit(e, desired_a, desired_b, min_a, min_b);
        let me = e.current_contract_address();
        TokenClient::new(e, &token_a(e)).transfer(&from, &me, &amount_a);
        TokenClient::new(e, &token_b(e)).transfer(&from, &me, &amount_b);
        let shares = finish_deposit(e, &from, supply, ra, rb, amount_a, amount_b);
        (amount_a, amount_b, shares)
    }

    /// Low-level deposit for routers (Uniswap V2 `mint`): both tokens must already be in the
    /// pool. Everything above the reserves counts as offered; the pool keeps the amounts that
    /// match its ratio, refunds the rest to `to` and mints the shares to `to`.
    /// Why: the user then signs two transfers with fixed amounts, so the signed auth no longer
    /// depends on reserves that can move between simulation and submission.
    /// Like `swap_raw`, it must run in the same transaction as the transfers (a router call):
    /// tokens left in the pool outside one can be claimed by anyone.
    #[when_not_paused]
    pub fn deposit_raw(e: &Env, to: Address, min_a: i128, min_b: i128) -> (i128, i128, i128) {
        bump(e);
        let me = e.current_contract_address();
        if to == me {
            panic_with_error!(e, PoolError::InvalidRecipient);
        }
        require_compliant(e, &to);
        let (ra, rb) = effective_reserves(e);
        let (ba, bb) = balances(e);
        let (offered_a, offered_b) = (ba - ra, bb - rb);
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

    /// Burn `shares` and receive the pro-rata part of both reserves. Works while paused.
    pub fn withdraw(e: &Env, from: Address, shares: i128, min_a: i128, min_b: i128) -> (i128, i128) {
        from.require_auth();
        bump(e);
        if shares <= 0 {
            panic_with_error!(e, PoolError::InvalidAmount);
        }
        if Base::balance(e, &from) < shares {
            panic_with_error!(e, PoolError::InsufficientShares);
        }
        let (ra, rb) = effective_reserves(e);
        let supply = TotalSupply::total_supply(e);
        let amount_a = mul_div_floor(e, &shares, &ra, &supply);
        let amount_b = mul_div_floor(e, &shares, &rb, &supply);
        if amount_a < min_a {
            panic_with_error!(e, PoolError::SlippageA);
        }
        if amount_b < min_b {
            panic_with_error!(e, PoolError::SlippageB);
        }
        if amount_a <= 0 && amount_b <= 0 {
            panic_with_error!(e, PoolError::InsufficientLiquidity);
        }
        burn_shares(e, &from, shares);

        if is_compliant(e, &from) {
            // Each side is paid independently: if one asset's issuer has frozen the pool (or a
            // non-regulated LP), the other side still goes out and the frozen side is owed.
            pay_or_owe(e, &token_a(e), true, &from, amount_a);
            pay_or_owe(e, &token_b(e), false, &from, amount_b);
        } else {
            // Compliance mode, frozen holder: hold both sides. Paying the free side would let her
            // sell the frozen asset (a friend swaps the free token in, takes the frozen one out).
            owe(e, &token_a(e), true, &from, amount_a);
            owe(e, &token_b(e), false, &from, amount_b);
        }

        update(e, ra - amount_a, rb - amount_b);
        Withdraw { provider: from, amount_a, amount_b, shares }.publish(e);
        (amount_a, amount_b)
    }

    // ---------------------------------------------------------------- swaps

    /// Exact-input swap: pull `amount_in` of `token_in` from `from`, send the output to `to`.
    #[when_not_paused]
    pub fn swap(e: &Env, from: Address, to: Address, token_in: Address, amount_in: i128, min_out: i128) -> i128 {
        from.require_auth();
        let (ra, rb) = reserves(e);
        let a_in = if token_in == token_a(e) {
            true
        } else if token_in == token_b(e) {
            false
        } else {
            panic_with_error!(e, PoolError::InvalidToken)
        };
        let (r_in, r_out) = if a_in { (ra, rb) } else { (rb, ra) };
        let out = amount_out(e, amount_in, r_in, r_out, fee_bps(e));
        if out < min_out || out <= 0 {
            panic_with_error!(e, PoolError::InsufficientOutput);
        }
        TokenClient::new(e, &token_in).transfer(&from, &e.current_contract_address(), &amount_in);
        if a_in {
            Self::swap_raw(e, 0, out, to);
        } else {
            Self::swap_raw(e, out, 0, to);
        }
        out
    }

    /// Low-level swap for routers (Uniswap V2 `swap`): the input must already be in the pool.
    /// Sends `out_a`/`out_b` to `to`, then checks the fee-adjusted constant product on balances.
    #[when_not_paused]
    pub fn swap_raw(e: &Env, out_a: i128, out_b: i128, to: Address) {
        bump(e);
        if out_a < 0 || out_b < 0 || (out_a == 0 && out_b == 0) {
            panic_with_error!(e, PoolError::InsufficientOutput);
        }
        let (ra, rb) = reserves(e);
        if out_a >= ra || out_b >= rb {
            panic_with_error!(e, PoolError::InsufficientLiquidity);
        }
        let (ta, tb) = (token_a(e), token_b(e));
        let me = e.current_contract_address();
        if to == ta || to == tb || to == me {
            panic_with_error!(e, PoolError::InvalidToken);
        }
        if out_a > 0 {
            TokenClient::new(e, &ta).transfer(&me, &to, &out_a);
        }
        if out_b > 0 {
            TokenClient::new(e, &tb).transfer(&me, &to, &out_b);
        }
        let (bal_a, bal_b) = balances(e);
        let in_a = (bal_a - (ra - out_a)).max(0);
        let in_b = (bal_b - (rb - out_b)).max(0);
        if in_a == 0 && in_b == 0 {
            panic_with_error!(e, PoolError::InvalidAmount);
        }
        // (bal_a·BPS − in_a·fee) · (bal_b·BPS − in_b·fee) ≥ ra·rb·BPS²   (computed in 256 bits)
        let fee = I256::from_i128(e, fee_bps(e) as i128);
        let bps = I256::from_i128(e, BPS);
        let adj_a = I256::from_i128(e, bal_a).mul(&bps).sub(&I256::from_i128(e, in_a).mul(&fee));
        let adj_b = I256::from_i128(e, bal_b).mul(&bps).sub(&I256::from_i128(e, in_b).mul(&fee));
        let k_before = I256::from_i128(e, ra).mul(&I256::from_i128(e, rb)).mul(&bps).mul(&bps);
        if adj_a.mul(&adj_b) < k_before {
            panic_with_error!(e, PoolError::KInvariant);
        }
        update(e, bal_a, bal_b);
        Swap { to, in_a, in_b, out_a, out_b }.publish(e);
    }

    /// Quote an exact-input swap at current reserves.
    pub fn get_amount_out(e: &Env, token_in: Address, amount_in: i128) -> i128 {
        let (ra, rb) = reserves(e);
        if token_in == token_a(e) {
            amount_out(e, amount_in, ra, rb, fee_bps(e))
        } else if token_in == token_b(e) {
            amount_out(e, amount_in, rb, ra, fee_bps(e))
        } else {
            panic_with_error!(e, PoolError::InvalidToken)
        }
    }

    // ---------------------------------------------------------------- reserves upkeep

    /// Set reserves to actual balances (e.g. after an issuer clawback reduced the pool's balance).
    pub fn sync(e: &Env) {
        bump(e);
        if TotalSupply::total_supply(e) == 0 {
            panic_with_error!(e, PoolError::InsufficientLiquidity);
        }
        let (a, b) = balances(e);
        update(e, a, b);
    }

    /// Lower the reserves to what the pool really holds (after an issuer clawback). Never raises
    /// them. Routers call it before sending tokens in: once the user's input is in the pool it
    /// would hide the shortfall, and the raw entry points would charge the user for it.
    pub fn reconcile(e: &Env) -> (i128, i128) {
        bump(e);
        effective_reserves(e)
    }

    /// Send any tokens above the recorded reserves (donations, mistaken transfers) to `to`.
    pub fn skim(e: &Env, to: Address) {
        let (ra, rb) = reserves(e);
        let (a, b) = balances(e);
        let me = e.current_contract_address();
        if a > ra {
            TokenClient::new(e, &token_a(e)).transfer(&me, &to, &(a - ra));
        }
        if b > rb {
            TokenClient::new(e, &token_b(e)).transfer(&me, &to, &(b - rb));
        }
    }

    // ---------------------------------------------------------------- views

    pub fn info(e: &Env) -> PoolInfo {
        let (reserve_a, reserve_b) = reserves(e);
        PoolInfo {
            token_a: token_a(e),
            token_b: token_b(e),
            reserve_a,
            reserve_b,
            fee_bps: fee_bps(e),
            total_shares: TotalSupply::total_supply(e),
        }
    }

    pub fn version(_e: &Env) -> u32 {
        VERSION
    }

    /// (token_a, token_b), sorted. Shared with LimeFX, so routers can check any pool's pair.
    pub fn tokens(e: &Env) -> (Address, Address) {
        (token_a(e), token_b(e))
    }

    /// Current cumulative prices (for off-chain or custom TWAP windows).
    pub fn observe(e: &Env) -> Observation {
        current_observation(e)
    }

    /// Time-weighted average prices, scaled by PRICE_SCALE:
    /// (price of token_a in token_b, price of token_b in token_a, actual window in seconds).
    /// Uses the newest stored observation at least `window` seconds old. The actual window can
    /// be longer than asked (observations are ≥ OBS_PERIOD apart and only written on activity),
    /// so callers should check it.
    pub fn twap(e: &Env, window: u64) -> (i128, i128, u64) {
        let now = current_observation(e);
        let len: u32 = e.storage().instance().get(&DataKey::ObsLen).unwrap_or(0);
        let mut best: Option<Observation> = None;
        for i in 0..len {
            let Some(o) = e.storage().persistent().get::<_, Observation>(&DataKey::ObsSlot(i)) else {
                continue;
            };
            if o.timestamp < now.timestamp && now.timestamp - o.timestamp >= window {
                let newer = match &best {
                    None => true,
                    Some(b) => o.timestamp > b.timestamp,
                };
                if newer {
                    best = Some(o);
                }
            }
        }
        let old = best.unwrap_or_else(|| panic_with_error!(e, PoolError::NotEnoughHistory));
        let dt = now.timestamp - old.timestamp;
        (
            now.cumulative_a.wrapping_sub(old.cumulative_a) / dt as i128,
            now.cumulative_b.wrapping_sub(old.cumulative_b) / dt as i128,
            dt,
        )
    }

    /// Tokens owed to `provider` from withdrawals whose transfer failed: (token_a, token_b).
    pub fn owed(e: &Env, provider: Address) -> (i128, i128) {
        e.storage().persistent().get(&DataKey::Owed(provider)).unwrap_or((0, 0))
    }

    /// Retry paying what `from` is owed (e.g. after the issuer re-authorized). Returns what is
    /// still owed afterwards.
    pub fn claim(e: &Env, from: Address) -> (i128, i128) {
        from.require_auth();
        bump(e);
        require_compliant(e, &from);
        let key = DataKey::Owed(from.clone());
        let (a, b): (i128, i128) = e.storage().persistent().get(&key).unwrap_or((0, 0));
        let (ta, tb) = owed_total(e);
        // Release the debt first; pay_or_owe re-records whatever still fails.
        e.storage().persistent().remove(&key);
        e.storage().instance().set(&DataKey::OwedTotal, &(ta - a, tb - b));
        pay_or_owe(e, &token_a(e), true, &from, a);
        pay_or_owe(e, &token_b(e), false, &from, b);
        Self::owed(e, from)
    }

    // ---------------------------------------------------------------- compliance (v3)

    /// The issuer of `token` (its SAC admin) switches compliance mode on or off for its side.
    /// While on, every LP share holder must hold an authorized trustline for `token`.
    pub fn set_compliance(e: &Env, token: Address, enabled: bool) {
        let (is_a, _) = require_issuer(e, &token);
        bump(e);
        let (mut reg_a, mut reg_b) = regulated(e);
        if is_a {
            reg_a = enabled;
        } else {
            reg_b = enabled;
        }
        e.storage().instance().set(&DataKey::Regulated, &(reg_a, reg_b));
        ComplianceSet { token, enabled }.publish(e);
    }

    /// Compliance mode per side: (token_a regulated, token_b regulated).
    pub fn compliance(e: &Env) -> (bool, bool) {
        regulated(e)
    }

    /// Issuer action (e.g. a court order): burn all of `holder`'s LP shares. The issuer's own
    /// token goes to `to` (pass the issuer itself to burn it) together with anything of it the
    /// holder was owed. The holder's share of the other token is paid out if `release_other`,
    /// else held as owed until the holder is compliant again (the issuer decides whether the
    /// freeze covers the proceeds too). No holder signature needed: this is the LP-position
    /// equivalent of a SAC `clawback`. Returns (shares burned, amount of the issuer's token sent).
    pub fn force_redeem(e: &Env, token: Address, holder: Address, to: Address, release_other: bool) -> (i128, i128) {
        let (is_a, _) = require_issuer(e, &token);
        bump(e);
        let (reg_a, reg_b) = regulated(e);
        if !(if is_a { reg_a } else { reg_b }) {
            panic_with_error!(e, PoolError::NotRegulated);
        }
        if holder == e.current_contract_address() || to == e.current_contract_address() {
            panic_with_error!(e, PoolError::InvalidRecipient);
        }
        let shares = Base::balance(e, &holder);
        let (mut seized, mut other) = (0i128, 0i128);
        let (ra, rb) = effective_reserves(e);
        if shares > 0 {
            let supply = TotalSupply::total_supply(e);
            let amount_a = mul_div_floor(e, &shares, &ra, &supply);
            let amount_b = mul_div_floor(e, &shares, &rb, &supply);
            burn_shares(e, &holder, shares);
            update(e, ra - amount_a, rb - amount_b);
            (seized, other) = if is_a { (amount_a, amount_b) } else { (amount_b, amount_a) };
        }
        // Sweep the holder's owed balance of this token too (e.g. from an earlier withdrawal
        // that failed because the holder was frozen).
        let key = DataKey::Owed(holder.clone());
        let (owed_a, owed_b): (i128, i128) = e.storage().persistent().get(&key).unwrap_or((0, 0));
        let owed_here = if is_a { owed_a } else { owed_b };
        if owed_here > 0 {
            let (ta, tb) = owed_total(e);
            if is_a {
                e.storage().persistent().set(&key, &(0i128, owed_b));
                e.storage().instance().set(&DataKey::OwedTotal, &(ta - owed_a, tb));
            } else {
                e.storage().persistent().set(&key, &(owed_a, 0i128));
                e.storage().instance().set(&DataKey::OwedTotal, &(ta, tb - owed_b));
            }
            seized += owed_here;
        }
        if shares == 0 && owed_here == 0 {
            panic_with_error!(e, PoolError::InsufficientShares);
        }
        if seized > 0 {
            TokenClient::new(e, &token).transfer(&e.current_contract_address(), &to, &seized);
        }
        let other_token = if is_a { token_b(e) } else { token_a(e) };
        if release_other {
            pay_or_owe(e, &other_token, !is_a, &holder, other);
        } else {
            owe(e, &other_token, !is_a, &holder, other);
        }
        ForceRedeem { holder, token, shares, seized, to, other, released: release_other }.publish(e);
        (shares, seized)
    }

    // ---------------------------------------------------------------- admin

    pub fn admin(e: &Env) -> Address {
        e.storage().instance().get(&DataKey::Admin).unwrap()
    }

    /// One-off clean-up after upgrading a v1 pool: drop the v1 instance-storage ring buffer
    /// (it was loaded on every call). TWAP history restarts from the next observation.
    pub fn migrate(e: &Env, caller: Address) {
        require_admin(e, &caller);
        let st = e.storage().instance();
        if st.has(&DataKey::Obs) {
            st.remove(&DataKey::Obs);
            st.set(&DataKey::ObsHead, &0u32);
            st.set(&DataKey::ObsLen, &0u32);
        }
    }

    /// v5: step 1 of an admin transfer. The new admin must call `accept_admin`; until then the
    /// current admin keeps all rights and can overwrite the proposal (e.g. after a typo).
    pub fn propose_admin(e: &Env, caller: Address, new_admin: Address) {
        require_admin(e, &caller);
        bump(e);
        e.storage().instance().set(&DataKey::PendingAdmin, &new_admin);
        AdminProposed { current: caller, pending: new_admin }.publish(e);
    }

    /// v5: step 2: the proposed admin takes over (a timelock does this via an executed operation).
    pub fn accept_admin(e: &Env, new_admin: Address) {
        new_admin.require_auth();
        bump(e);
        let st = e.storage().instance();
        if st.get::<_, Address>(&DataKey::PendingAdmin) != Some(new_admin.clone()) {
            panic_with_error!(e, PoolError::Unauthorized);
        }
        let previous: Address = st.get(&DataKey::Admin).unwrap();
        st.set(&DataKey::Admin, &new_admin);
        st.remove(&DataKey::PendingAdmin);
        AdminChanged { previous, admin: new_admin }.publish(e);
    }

    pub fn pending_admin(e: &Env) -> Option<Address> {
        e.storage().instance().get(&DataKey::PendingAdmin)
    }

    /// v5: the guardian may only `pause` (instant emergency brake). None removes it.
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
impl Pausable for LimeSwapPool {
    fn paused(e: &Env) -> bool {
        pausable::paused(e)
    }

    /// Admin or guardian (instant, for emergencies). Withdrawals keep working while paused.
    fn pause(e: &Env, caller: Address) {
        caller.require_auth();
        let st = e.storage().instance();
        let admin: Address = st.get(&DataKey::Admin).unwrap();
        if caller != admin && st.get::<_, Address>(&DataKey::Guardian) != Some(caller) {
            panic_with_error!(e, PoolError::Unauthorized);
        }
        pausable::pause(e);
    }

    fn unpause(e: &Env, caller: Address) {
        require_admin(e, &caller);
        pausable::unpause(e);
    }
}

#[contractimpl]
impl FungibleToken for LimeSwapPool {
    type ContractType = Compose<(TotalSupply,)>;

    fn balance(e: &Env, account: Address) -> i128 {
        Self::ContractType::balance(e, &account)
    }

    fn allowance(e: &Env, owner: Address, spender: Address) -> i128 {
        Self::ContractType::allowance(e, &owner, &spender)
    }

    fn transfer(e: &Env, from: Address, to: MuxedAddress, amount: i128) {
        check_share_transfer(e, &from, &to.address());
        Self::ContractType::transfer(e, &from, &to, amount);
    }

    fn transfer_from(e: &Env, spender: Address, from: Address, to: Address, amount: i128) {
        check_share_transfer(e, &from, &to);
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
impl FungibleTotalSupply for LimeSwapPool {}
