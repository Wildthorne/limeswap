#![cfg(test)]
extern crate std;

use super::*;
use soroban_sdk::{contract, contractimpl, testutils::Address as _, token::StellarAssetClient, vec, Address, Env};

mod pool {
    soroban_sdk::contractimport!(file = "../../target/wasm32v1-none/release/lime_amm_pool.wasm");
}

/// Minimal stand-in for a Soroswap pair with the same swap rule (fee = ceil(3‰) of input,
/// k checked on fee-adjusted balances). The real pair is exercised on Testnet.
#[contract]
struct MockSoroswapPair;

#[contracttype]
enum K {
    T0,
    T1,
    R0,
    R1,
}

#[contractimpl]
impl MockSoroswapPair {
    pub fn init(e: Env, t0: Address, t1: Address) {
        e.storage().instance().set(&K::T0, &t0);
        e.storage().instance().set(&K::T1, &t1);
    }
    pub fn sync(e: Env) {
        let me = e.current_contract_address();
        let t0: Address = e.storage().instance().get(&K::T0).unwrap();
        let t1: Address = e.storage().instance().get(&K::T1).unwrap();
        e.storage().instance().set(&K::R0, &TokenClient::new(&e, &t0).balance(&me));
        e.storage().instance().set(&K::R1, &TokenClient::new(&e, &t1).balance(&me));
    }
    pub fn token_0(e: Env) -> Address {
        e.storage().instance().get(&K::T0).unwrap()
    }
    pub fn get_reserves(e: Env) -> (i128, i128) {
        (e.storage().instance().get(&K::R0).unwrap(), e.storage().instance().get(&K::R1).unwrap())
    }
    pub fn swap(e: Env, a0: i128, a1: i128, to: Address) {
        let me = e.current_contract_address();
        let (r0, r1) = Self::get_reserves(e.clone());
        let t0: Address = e.storage().instance().get(&K::T0).unwrap();
        let t1: Address = e.storage().instance().get(&K::T1).unwrap();
        if a0 > 0 {
            TokenClient::new(&e, &t0).transfer(&me, &to, &a0);
        }
        if a1 > 0 {
            TokenClient::new(&e, &t1).transfer(&me, &to, &a1);
        }
        let b0 = TokenClient::new(&e, &t0).balance(&me);
        let b1 = TokenClient::new(&e, &t1).balance(&me);
        let in0 = (b0 - (r0 - a0)).max(0);
        let in1 = (b1 - (r1 - a1)).max(0);
        let f0 = (in0 * 3 + 999) / 1000;
        let f1 = (in1 * 3 + 999) / 1000;
        assert!((b0 - f0) * (b1 - f1) >= r0 * r1, "SwapKConstantNotMet");
        Self::sync(e);
    }
}

struct S {
    e: Env,
    arb: LimeArbClient<'static>,
    lp: Address,
    trader: Address,
    xlm: Address,
    lime: Address,
    lime_pool: Address,
    soro: Address,
}

fn setup(lime_pool_xlm: i128, soro_xlm: i128) -> S {
    let e = Env::default();
    e.mock_all_auths();
    e.cost_estimate().budget().reset_unlimited();
    let admin = Address::generate(&e);
    let lp = Address::generate(&e);
    let trader = Address::generate(&e);
    let (mut xlm, mut lime) = (
        e.register_stellar_asset_contract_v2(admin.clone()).address(),
        e.register_stellar_asset_contract_v2(admin.clone()).address(),
    );
    if xlm > lime {
        core::mem::swap(&mut xlm, &mut lime);
    }
    for t in [&xlm, &lime] {
        StellarAssetClient::new(&e, t).mint(&lp, &1_000_000_000_000);
        StellarAssetClient::new(&e, t).mint(&trader, &1_000_000_000_000);
    }
    // LimeSwap pool: 10,000 LIME vs `lime_pool_xlm` XLM.
    let lime_pool = e.register(pool::WASM, (&admin, &xlm, &lime, 30u32));
    pool::Client::new(&e, &lime_pool).deposit(&lp, &lime_pool_xlm, &100_000_000_000, &0, &0);
    // Soroswap-style pair: 10,000 LIME vs `soro_xlm` XLM.
    let soro = e.register(MockSoroswapPair, ());
    let pair = MockSoroswapPairClient::new(&e, &soro);
    pair.init(&xlm, &lime);
    TokenClient::new(&e, &xlm).transfer(&lp, &soro, &soro_xlm);
    TokenClient::new(&e, &lime).transfer(&lp, &soro, &100_000_000_000);
    pair.sync();
    let arb = LimeArbClient::new(&e, &e.register(LimeArb, ()));
    S { e, arb, lp, trader, xlm, lime, lime_pool, soro }
}

fn route(s: &S) -> Vec<Hop> {
    // XLM → LIME on LimeSwap (cheap LIME), LIME → XLM on Soroswap (dear LIME).
    vec![
        &s.e,
        Hop { venue: LIMESWAP, pool: s.lime_pool.clone(), token_in: s.xlm.clone(), token_out: s.lime.clone() },
        Hop { venue: SOROSWAP, pool: s.soro.clone(), token_in: s.lime.clone(), token_out: s.xlm.clone() },
    ]
}

#[test]
fn cross_protocol_cycle_is_atomic_and_profitable() {
    let s = setup(10_000_000_000, 11_000_000_000); // 0.100 vs 0.110 XLM per LIME
    let amount = 200_000_000; // 20 XLM
    let quote = s.arb.quote(&amount, &route(&s));
    let expected = quote.get(2).unwrap() - amount;
    assert!(expected > 0);
    let before = TokenClient::new(&s.e, &s.xlm).balance(&s.trader);
    let profit = s.arb.execute(&s.trader, &amount, &1, &route(&s));
    assert_eq!(profit, expected);
    assert_eq!(TokenClient::new(&s.e, &s.xlm).balance(&s.trader) - before, expected);
    assert_eq!(TokenClient::new(&s.e, &s.lime).balance(&s.arb.address), 0);
    let _ = &s.lp;
}

#[test]
fn unprofitable_cycle_reverts() {
    let s = setup(10_000_000_000, 10_000_000_000); // same price: fees make it a loss
    assert_eq!(
        s.arb.try_execute(&s.trader, &200_000_000, &0, &route(&s)),
        Err(Ok(ArbError::Unprofitable.into()))
    );
}

#[test]
fn route_must_be_a_connected_cycle() {
    let s = setup(10_000_000_000, 11_000_000_000);
    let mut r = route(&s);
    r.pop_back();
    assert_eq!(s.arb.try_quote(&1_000, &r), Err(Ok(ArbError::NotACycle.into())));
    let broken = vec![
        &s.e,
        Hop { venue: LIMESWAP, pool: s.lime_pool.clone(), token_in: s.xlm.clone(), token_out: s.lime.clone() },
        Hop { venue: SOROSWAP, pool: s.soro.clone(), token_in: s.xlm.clone(), token_out: s.xlm.clone() },
    ];
    assert_eq!(s.arb.try_quote(&1_000, &broken), Err(Ok(ArbError::BrokenRoute.into())));
}
