#![no_std]
//! LimeSwap router: liquidity helpers and exact-input multi-hop swaps with slippage and deadline.
//!
//! Multi-hop swaps follow Uniswap V2: the router sends the input once into the first pool,
//! each pool pays its output straight into the next pool (`swap_raw`), and the last pool pays
//! the recipient. The only token movement the user signs is the first transfer, with a fixed
//! amount — so the signed auth tree never depends on reserves that may move before submission.
//! A path may start and end with the same token: that is an atomic arbitrage cycle.
//!
//! v2:
//! - `swap_route` / `quote_route`: each hop is a LimeSwap pool (by fee tier) or a LimeFX pool
//!   (by address), so routes and arbitrage cycles can go through the oracle-anchored pool. The
//!   output is checked on the recipient's real balance, not on what the pools report.
//! - Deposits send the user's *desired* amounts (fixed, so the signed auth can't go stale when
//!   reserves move) and let the pool refund the excess (`deposit_raw`). `add_liquidity_to`
//!   does the same for any pool with `deposit_raw`, including LimeFX.

use soroban_sdk::{
    contract, contractclient, contracterror, contractimpl, contracttype, panic_with_error,
    token::TokenClient, Address, Env, Vec, I256,
};

#[cfg(test)]
mod test;

pub const VERSION: u32 = 2;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum RouterError {
    Expired = 1,
    InvalidPath = 2,
    PoolNotFound = 3,
    InsufficientOutput = 4,
    /// The pool does not trade the hop's tokens.
    WrongPool = 5,
}

/// One hop of a route: a LimeSwap pool found via the factory by fee tier, or a LimeFX pool.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Hop {
    Pool(u32),
    Fx(Address),
}

/// Subset of the pool interface the router uses.
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

#[allow(dead_code)]
#[contractclient(name = "PoolClient")]
pub trait PoolInterface {
    fn info(e: Env) -> PoolInfo;
    fn deposit(e: Env, from: Address, desired_a: i128, desired_b: i128, min_a: i128, min_b: i128) -> (i128, i128, i128);
    fn withdraw(e: Env, from: Address, shares: i128, min_a: i128, min_b: i128) -> (i128, i128);
    fn swap_raw(e: Env, out_a: i128, out_b: i128, to: Address);
    fn deposit_raw(e: Env, to: Address, min_a: i128, min_b: i128) -> (i128, i128, i128);
    fn tokens(e: Env) -> (Address, Address);
    fn reconcile(e: Env) -> (i128, i128);
}

/// What a LimeFX quote returns (only `amount_out` is used).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FxQuote {
    pub amount_out: i128,
    pub fee_bps: u32,
    pub oracle_price: i128,
}

#[allow(dead_code)]
#[contractclient(name = "FxPoolClient")]
pub trait FxPoolInterface {
    fn quote(e: Env, token_in: Address, amount_in: i128) -> FxQuote;
    fn swap_in(e: Env, token_in: Address, min_out: i128, to: Address) -> i128;
    fn tokens(e: Env) -> (Address, Address);
    fn reconcile(e: Env) -> (i128, i128);
}

#[allow(dead_code)]
#[contractclient(name = "FactoryClient")]
pub trait FactoryInterface {
    fn get_pool(e: Env, token_a: Address, token_b: Address, fee_bps: u32) -> Option<Address>;
    fn create_pool(e: Env, token_a: Address, token_b: Address, fee_bps: u32) -> Address;
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Factory,
}

const BPS: i128 = 10_000;

/// Same formula as the pool (and CAP-38). Kept local so the router never trusts a pool's quote.
fn amount_out(e: &Env, amount_in: i128, reserve_in: i128, reserve_out: i128, fee_bps: u32) -> i128 {
    if amount_in <= 0 || reserve_in <= 0 || reserve_out <= 0 {
        panic_with_error!(e, RouterError::InsufficientOutput);
    }
    // 256-bit intermediates, floor division: bit-for-bit the same result as the pool's math.
    let in_with_fee = I256::from_i128(e, amount_in)
        .mul(&I256::from_i128(e, BPS - fee_bps as i128))
        .div(&I256::from_i128(e, BPS));
    in_with_fee
        .mul(&I256::from_i128(e, reserve_out))
        .div(&I256::from_i128(e, reserve_in).add(&in_with_fee))
        .to_i128()
        .unwrap_or_else(|| panic_with_error!(e, RouterError::InsufficientOutput))
}

fn check_deadline(e: &Env, deadline: u64) {
    if e.ledger().timestamp() > deadline {
        panic_with_error!(e, RouterError::Expired);
    }
}

fn factory(e: &Env) -> FactoryClient<'_> {
    let id: Address = e.storage().instance().get(&DataKey::Factory).unwrap();
    FactoryClient::new(e, &id)
}

fn pool_for(e: &Env, a: &Address, b: &Address, fee_bps: u32) -> Address {
    factory(e)
        .get_pool(a, b, &fee_bps)
        .unwrap_or_else(|| panic_with_error!(e, RouterError::PoolNotFound))
}

/// Resolve pools and compute every hop's output. Returns (pools, amounts) where
/// amounts[0] = amount_in and amounts[i+1] = output of hop i.
fn plan(e: &Env, amount_in: i128, tokens: &Vec<Address>, fees: &Vec<u32>) -> (Vec<Address>, Vec<i128>) {
    if tokens.len() < 2 || fees.len() != tokens.len() - 1 {
        panic_with_error!(e, RouterError::InvalidPath);
    }
    let mut pools = Vec::new(e);
    let mut amounts = Vec::from_array(e, [amount_in]);
    for i in 0..fees.len() {
        let (t_in, t_out) = (tokens.get(i).unwrap(), tokens.get(i + 1).unwrap());
        if t_in == t_out {
            panic_with_error!(e, RouterError::InvalidPath);
        }
        let pool = pool_for(e, &t_in, &t_out, fees.get(i).unwrap());
        let info = PoolClient::new(e, &pool).info();
        let (r_in, r_out) = if t_in == info.token_a {
            (info.reserve_a, info.reserve_b)
        } else {
            (info.reserve_b, info.reserve_a)
        };
        let out = amount_out(e, amounts.last().unwrap(), r_in, r_out, info.fee_bps);
        amounts.push_back(out);
        pools.push_back(pool);
    }
    (pools, amounts)
}

/// Output of one cp hop at the pool's current reserves.
fn cp_out(e: &Env, pool: &Address, t_in: &Address, amount_in: i128) -> i128 {
    let info = PoolClient::new(e, pool).info();
    let (r_in, r_out) = if *t_in == info.token_a {
        (info.reserve_a, info.reserve_b)
    } else {
        (info.reserve_b, info.reserve_a)
    };
    amount_out(e, amount_in, r_in, r_out, info.fee_bps)
}

/// The pool address of a hop, checked to trade exactly (t_in, t_out).
fn hop_pool(e: &Env, hop: &Hop, t_in: &Address, t_out: &Address) -> Address {
    if t_in == t_out {
        panic_with_error!(e, RouterError::InvalidPath);
    }
    match hop {
        Hop::Pool(fee) => pool_for(e, t_in, t_out, *fee),
        Hop::Fx(pool) => {
            let (a, b) = FxPoolClient::new(e, pool).tokens();
            if !((a == *t_in && b == *t_out) || (a == *t_out && b == *t_in)) {
                panic_with_error!(e, RouterError::WrongPool);
            }
            pool.clone()
        }
    }
}

fn check_route(e: &Env, tokens: &Vec<Address>, hops: &Vec<Hop>) {
    if tokens.len() < 2 || hops.len() != tokens.len() - 1 {
        panic_with_error!(e, RouterError::InvalidPath);
    }
}

/// Send the desired amounts into `pool` and let it keep what matches its ratio. `tokens` and the
/// amounts are in the pool's (sorted) order.
#[allow(clippy::too_many_arguments)]
fn deposit_fixed(
    e: &Env,
    from: &Address,
    pool: &Address,
    tokens: (Address, Address),
    desired_a: i128,
    desired_b: i128,
    min_a: i128,
    min_b: i128,
) -> (i128, i128, i128) {
    // Before the transfers: a clawback shortfall must not be netted against the user's tokens.
    PoolClient::new(e, pool).reconcile();
    TokenClient::new(e, &tokens.0).transfer(from, pool, &desired_a);
    TokenClient::new(e, &tokens.1).transfer(from, pool, &desired_b);
    PoolClient::new(e, pool).deposit_raw(from, &min_a, &min_b)
}

#[contract]
pub struct LimeSwapRouter;

#[contractimpl]
impl LimeSwapRouter {
    pub fn __constructor(e: &Env, factory: Address) {
        e.storage().instance().set(&DataKey::Factory, &factory);
    }

    pub fn factory(e: &Env) -> Address {
        e.storage().instance().get(&DataKey::Factory).unwrap()
    }

    pub fn version(_e: &Env) -> u32 {
        VERSION
    }

    /// Add liquidity; creates the pool if it does not exist yet. Amounts are given in the
    /// caller's token order. Returns (amount for token_a, amount for token_b, shares).
    #[allow(clippy::too_many_arguments)]
    pub fn add_liquidity(
        e: &Env,
        from: Address,
        token_a: Address,
        token_b: Address,
        fee_bps: u32,
        desired_a: i128,
        desired_b: i128,
        min_a: i128,
        min_b: i128,
        deadline: u64,
    ) -> (i128, i128, i128) {
        from.require_auth();
        check_deadline(e, deadline);
        let f = factory(e);
        let pool = match f.get_pool(&token_a, &token_b, &fee_bps) {
            Some(p) => p,
            None => f.create_pool(&token_a, &token_b, &fee_bps),
        };
        let sorted = PoolClient::new(e, &pool).tokens();
        if token_a == sorted.0 {
            deposit_fixed(e, &from, &pool, sorted, desired_a, desired_b, min_a, min_b)
        } else {
            let (b, a, s) = deposit_fixed(e, &from, &pool, sorted, desired_b, desired_a, min_b, min_a);
            (a, b, s)
        }
    }

    /// Add liquidity to any pool with `deposit_raw` (a LimeSwap pool or LimeFX). `token_a` /
    /// `token_b` must be the pool's `tokens()` (sorted), and the amounts follow that order: the
    /// caller states which tokens it signs away instead of trusting the pool's own answer.
    /// Returns (amount_a, amount_b, shares).
    #[allow(clippy::too_many_arguments)]
    pub fn add_liquidity_to(
        e: &Env,
        from: Address,
        pool: Address,
        token_a: Address,
        token_b: Address,
        desired_a: i128,
        desired_b: i128,
        min_a: i128,
        min_b: i128,
        deadline: u64,
    ) -> (i128, i128, i128) {
        from.require_auth();
        check_deadline(e, deadline);
        let sorted = PoolClient::new(e, &pool).tokens();
        if sorted != (token_a, token_b) {
            panic_with_error!(e, RouterError::WrongPool);
        }
        deposit_fixed(e, &from, &pool, sorted, desired_a, desired_b, min_a, min_b)
    }

    /// Remove liquidity. Returns amounts in the caller's token order.
    #[allow(clippy::too_many_arguments)]
    pub fn remove_liquidity(
        e: &Env,
        from: Address,
        token_a: Address,
        token_b: Address,
        fee_bps: u32,
        shares: i128,
        min_a: i128,
        min_b: i128,
        deadline: u64,
    ) -> (i128, i128) {
        from.require_auth();
        check_deadline(e, deadline);
        let client = PoolClient::new(e, &pool_for(e, &token_a, &token_b, fee_bps));
        if token_a < token_b {
            client.withdraw(&from, &shares, &min_a, &min_b)
        } else {
            let (b, a) = client.withdraw(&from, &shares, &min_b, &min_a);
            (a, b)
        }
    }

    /// Quote an exact-input path: tokens = [in, hop1, …, out], fees = fee tier per hop.
    pub fn quote(e: &Env, amount_in: i128, tokens: Vec<Address>, fees: Vec<u32>) -> Vec<i128> {
        plan(e, amount_in, &tokens, &fees).1
    }

    /// Swap exactly `amount_in` of tokens[0] along the path; at least `min_out` of the last token
    /// goes to `to`. Returns the amount after each hop.
    pub fn swap_exact_in(
        e: &Env,
        from: Address,
        to: Address,
        amount_in: i128,
        min_out: i128,
        tokens: Vec<Address>,
        fees: Vec<u32>,
        deadline: u64,
    ) -> Vec<i128> {
        from.require_auth();
        check_deadline(e, deadline);
        // Clawback shortfalls first (otherwise `swap_raw` fails its invariant check until `sync`).
        for p in plan(e, amount_in, &tokens, &fees).0.iter() {
            PoolClient::new(e, &p).reconcile();
        }
        let (pools, amounts) = plan(e, amount_in, &tokens, &fees);
        if amounts.last().unwrap() < min_out {
            panic_with_error!(e, RouterError::InsufficientOutput);
        }

        TokenClient::new(e, &tokens.get(0).unwrap()).transfer(&from, &pools.get(0).unwrap(), &amount_in);
        for i in 0..pools.len() {
            let pool = PoolClient::new(e, &pools.get(i).unwrap());
            let t_out = tokens.get(i + 1).unwrap();
            let out = amounts.get(i + 1).unwrap();
            let next = if i + 1 < pools.len() { pools.get(i + 1).unwrap() } else { to.clone() };
            let token_a = pool.info().token_a;
            if t_out == token_a {
                pool.swap_raw(&out, &0, &next);
            } else {
                pool.swap_raw(&0, &out, &next);
            }
        }
        amounts
    }

    /// Quote a route at current state: tokens = [in, …, out], one hop per pair of tokens.
    /// Returns the amount after each hop (amounts[0] = amount_in). Each hop is priced on the
    /// pool's current state, so a route that uses the same pool twice is quoted too high
    /// (`swap_route` prices hops live and is exact).
    pub fn quote_route(e: &Env, amount_in: i128, tokens: Vec<Address>, hops: Vec<Hop>) -> Vec<i128> {
        check_route(e, &tokens, &hops);
        let mut amounts = Vec::from_array(e, [amount_in]);
        for i in 0..hops.len() {
            let (t_in, t_out) = (tokens.get(i).unwrap(), tokens.get(i + 1).unwrap());
            let hop = hops.get(i).unwrap();
            let pool = hop_pool(e, &hop, &t_in, &t_out);
            let x = amounts.last().unwrap();
            let out = match hop {
                Hop::Pool(_) => cp_out(e, &pool, &t_in, x),
                Hop::Fx(_) => FxPoolClient::new(e, &pool).quote(&t_in, &x).amount_out,
            };
            amounts.push_back(out);
        }
        amounts
    }

    /// Swap exactly `amount_in` of tokens[0] along a route of LimeSwap and LimeFX hops; at least
    /// `min_out` of the last token must reach `to` (measured on its balance). Returns the amount
    /// after each hop. A route that starts and ends with the same token is an arbitrage cycle.
    #[allow(clippy::too_many_arguments)]
    pub fn swap_route(
        e: &Env,
        from: Address,
        to: Address,
        amount_in: i128,
        min_out: i128,
        tokens: Vec<Address>,
        hops: Vec<Hop>,
        deadline: u64,
    ) -> Vec<i128> {
        from.require_auth();
        check_deadline(e, deadline);
        check_route(e, &tokens, &hops);
        let mut pools = Vec::new(e);
        for i in 0..hops.len() {
            pools.push_back(hop_pool(e, &hops.get(i).unwrap(), &tokens.get(i).unwrap(), &tokens.get(i + 1).unwrap()));
        }
        // Clawback shortfalls first: once tokens are in, a pool can't tell them from the input.
        for i in 0..hops.len() {
            match hops.get(i).unwrap() {
                Hop::Pool(_) => PoolClient::new(e, &pools.get(i).unwrap()).reconcile(),
                Hop::Fx(_) => FxPoolClient::new(e, &pools.get(i).unwrap()).reconcile(),
            };
        }
        // The only transfer the user signs: a fixed amount into the first pool.
        TokenClient::new(e, &tokens.get(0).unwrap()).transfer(&from, &pools.get(0).unwrap(), &amount_in);
        let last = TokenClient::new(e, &tokens.last().unwrap());
        let before = last.balance(&to);

        let mut amounts = Vec::from_array(e, [amount_in]);
        for i in 0..pools.len() {
            let pool = pools.get(i).unwrap();
            let (t_in, t_out) = (tokens.get(i).unwrap(), tokens.get(i + 1).unwrap());
            let next = if i + 1 < pools.len() { pools.get(i + 1).unwrap() } else { to.clone() };
            let x = amounts.last().unwrap();
            // Hops run in order, so each one is priced on the state the previous hops left.
            let out = match hops.get(i).unwrap() {
                Hop::Pool(_) => {
                    let out = cp_out(e, &pool, &t_in, x);
                    let client = PoolClient::new(e, &pool);
                    if t_out == client.info().token_a {
                        client.swap_raw(&out, &0, &next);
                    } else {
                        client.swap_raw(&0, &out, &next);
                    }
                    out
                }
                Hop::Fx(_) => FxPoolClient::new(e, &pool).swap_in(&t_in, &0, &next),
            };
            amounts.push_back(out);
        }
        if last.balance(&to) - before < min_out {
            panic_with_error!(e, RouterError::InsufficientOutput);
        }
        amounts
    }
}
