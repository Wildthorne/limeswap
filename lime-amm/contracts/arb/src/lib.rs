#![no_std]
//! LimeArb executor: one atomic route across different AMM protocols.
//!
//! A route is a list of hops; each hop is a LimeSwap pool or a Soroswap pair. The caller's input
//! is sent once into the first pool, every pool pays its output straight into the next one
//! (both protocols use the Uniswap-V2 "send first, then swap(out0, out1, to)" pattern), and the
//! last pool pays the caller. At the end the caller's balance of the start token must have grown
//! by at least `min_profit`, otherwise everything reverts — the caller can never lose money
//! (except the network fee).
//!
//! The executor holds no funds and no state, so it needs no admin and is not upgradable.

use soroban_sdk::{
    contract, contractclient, contracterror, contractimpl, contracttype, panic_with_error,
    token::TokenClient, Address, Env, Vec, I256,
};

#[cfg(test)]
mod test;

pub const VERSION: u32 = 1;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum ArbError {
    EmptyRoute = 1,
    NotACycle = 2,
    BrokenRoute = 3,
    UnknownVenue = 4,
    Unprofitable = 5,
    InvalidAmount = 6,
}

/// Venue kinds.
pub const LIMESWAP: u32 = 0;
pub const SOROSWAP: u32 = 1;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Hop {
    pub venue: u32,
    pub pool: Address,
    pub token_in: Address,
    pub token_out: Address,
}

// ---- LimeSwap pool (subset)
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
#[contractclient(name = "LimeSwapPoolClient")]
pub trait LimeSwapPool {
    fn info(e: Env) -> PoolInfo;
    fn swap_raw(e: Env, out_a: i128, out_b: i128, to: Address);
}

// ---- Soroswap pair (subset; see github.com/soroswap/core contracts/pair)
#[allow(dead_code)]
#[contractclient(name = "SoroswapPairClient")]
pub trait SoroswapPair {
    fn token_0(e: Env) -> Address;
    fn get_reserves(e: Env) -> (i128, i128);
    fn swap(e: Env, amount_0_out: i128, amount_1_out: i128, to: Address);
}

fn i256(e: &Env, v: i128) -> I256 {
    I256::from_i128(e, v)
}

/// LimeSwap / CAP-38: fee = floor-adjusted in·(10⁴−f)/10⁴.
fn limeswap_out(e: &Env, amount_in: i128, r_in: i128, r_out: i128, fee_bps: u32) -> i128 {
    let in_fee = i256(e, amount_in).mul(&i256(e, 10_000 - fee_bps as i128)).div(&i256(e, 10_000));
    in_fee.mul(&i256(e, r_out)).div(&i256(e, r_in).add(&in_fee)).to_i128().unwrap()
}

/// Soroswap: fee = ceil(in·3/1000), out = (in−fee)·R_out / (R_in + in − fee).
fn soroswap_out(e: &Env, amount_in: i128, r_in: i128, r_out: i128) -> i128 {
    let fee = (amount_in * 3 + 999) / 1000;
    let less = i256(e, amount_in - fee);
    less.mul(&i256(e, r_out)).div(&i256(e, r_in).add(&less)).to_i128().unwrap()
}

/// Output of one hop at current reserves, and the (out_0, out_1) pair to request.
fn quote_hop(e: &Env, hop: &Hop, amount_in: i128) -> (i128, i128, i128) {
    match hop.venue {
        LIMESWAP => {
            let i = LimeSwapPoolClient::new(e, &hop.pool).info();
            if hop.token_in == i.token_a {
                let out = limeswap_out(e, amount_in, i.reserve_a, i.reserve_b, i.fee_bps);
                (out, 0, out)
            } else {
                let out = limeswap_out(e, amount_in, i.reserve_b, i.reserve_a, i.fee_bps);
                (out, out, 0)
            }
        }
        SOROSWAP => {
            let p = SoroswapPairClient::new(e, &hop.pool);
            let (r0, r1) = p.get_reserves();
            if hop.token_in == p.token_0() {
                let out = soroswap_out(e, amount_in, r0, r1);
                (out, 0, out)
            } else {
                let out = soroswap_out(e, amount_in, r1, r0);
                (out, out, 0)
            }
        }
        _ => panic_with_error!(e, ArbError::UnknownVenue),
    }
}

fn check_route(e: &Env, hops: &Vec<Hop>) -> Address {
    if hops.is_empty() {
        panic_with_error!(e, ArbError::EmptyRoute);
    }
    for i in 1..hops.len() {
        if hops.get(i).unwrap().token_in != hops.get(i - 1).unwrap().token_out {
            panic_with_error!(e, ArbError::BrokenRoute);
        }
    }
    let start = hops.get(0).unwrap().token_in;
    if hops.last().unwrap().token_out != start {
        panic_with_error!(e, ArbError::NotACycle);
    }
    start
}

#[contract]
pub struct LimeArb;

#[contractimpl]
impl LimeArb {
    pub fn version(_e: &Env) -> u32 {
        VERSION
    }

    /// Simulate the route at current reserves: amount after each hop.
    pub fn quote(e: &Env, amount_in: i128, hops: Vec<Hop>) -> Vec<i128> {
        check_route(e, &hops);
        let mut amounts = Vec::from_array(e, [amount_in]);
        for hop in hops.iter() {
            let (out, _, _) = quote_hop(e, &hop, amounts.last().unwrap());
            amounts.push_back(out);
        }
        amounts
    }

    /// Run the cycle. Reverts unless the caller ends with ≥ `min_profit` more of the start token.
    /// Returns the realized profit.
    pub fn execute(e: &Env, caller: Address, amount_in: i128, min_profit: i128, hops: Vec<Hop>) -> i128 {
        caller.require_auth();
        if amount_in <= 0 || min_profit < 0 {
            panic_with_error!(e, ArbError::InvalidAmount);
        }
        let start = check_route(e, &hops);
        let token = TokenClient::new(e, &start);
        let before = token.balance(&caller);

        token.transfer(&caller, &hops.get(0).unwrap().pool, &amount_in);
        let mut amount = amount_in;
        for i in 0..hops.len() {
            let hop = hops.get(i).unwrap();
            let (out, out_0, out_1) = quote_hop(e, &hop, amount);
            let to = if i + 1 < hops.len() { hops.get(i + 1).unwrap().pool } else { caller.clone() };
            match hop.venue {
                LIMESWAP => LimeSwapPoolClient::new(e, &hop.pool).swap_raw(&out_0, &out_1, &to),
                _ => SoroswapPairClient::new(e, &hop.pool).swap(&out_0, &out_1, &to),
            }
            amount = out;
        }

        let profit = token.balance(&caller) - before;
        if profit < min_profit {
            panic_with_error!(e, ArbError::Unprofitable);
        }
        profit
    }
}
