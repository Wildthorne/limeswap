#![cfg(test)]
//! Regression tests for the security review of v1 (findings fixed in v2), plus the v1 → v2
//! in-place upgrade with the frozen release binary.
extern crate std;

use super::*;
use soroban_sdk::{
    testutils::{Address as _, IssuerFlags},
    token::StellarAssetClient,
    Address, Env,
};

mod v1 {
    soroban_sdk::contractimport!(file = "../../releases/lime_amm_pool_v1.wasm");
}
mod current {
    soroban_sdk::contractimport!(file = "../../target/wasm32v1-none/release/lime_amm_pool.wasm");
}

struct S {
    e: Env,
    a: Address,
    b: Address,
    pool: LimeSwapPoolClient<'static>,
}

fn new_token(e: &Env, admin: &Address) -> Address {
    let sac = e.register_stellar_asset_contract_v2(admin.clone());
    sac.issuer().set_flag(IssuerFlags::ClawbackEnabledFlag);
    sac.issuer().set_flag(IssuerFlags::RevocableFlag);
    sac.address()
}

fn tokens(e: &Env, admin: &Address) -> (Address, Address) {
    let (a, b) = (new_token(e, admin), new_token(e, admin));
    if a < b { (a, b) } else { (b, a) }
}

fn setup() -> S {
    let e = Env::default();
    e.mock_all_auths();
    e.cost_estimate().budget().reset_unlimited();
    let admin = Address::generate(&e);
    let (a, b) = tokens(&e, &admin);
    let id = e.register(LimeSwapPool, (&admin, &a, &b, 30u32));
    let pool = LimeSwapPoolClient::new(&e, &id);
    S { e, a, b, pool }
}

fn fund(s: &S, who: &Address, amount: i128) {
    StellarAssetClient::new(&s.e, &s.a).mint(who, &amount);
    StellarAssetClient::new(&s.e, &s.b).mint(who, &amount);
}

fn bal(s: &S, t: &Address, who: &Address) -> i128 {
    TokenClient::new(&s.e, t).balance(who)
}

/// MEDIUM-1: after a clawback, LPs share the loss pro rata, whoever withdraws first.
#[test]
fn clawback_loss_is_shared_pro_rata() {
    let s = setup();
    let lp1 = Address::generate(&s.e);
    let lp2 = Address::generate(&s.e);
    fund(&s, &lp1, 1_000_000);
    fund(&s, &lp2, 1_000_000);
    let (_, _, sh1) = s.pool.deposit(&lp1, &1_000_000, &1_000_000, &0, &0);
    let (_, _, sh2) = s.pool.deposit(&lp2, &1_000_000, &1_000_000, &0, &0);
    StellarAssetClient::new(&s.e, &s.a).clawback(&s.pool.address, &1_000_000);
    let (a1, _) = s.pool.withdraw(&lp1, &sh1, &0, &0);
    let (a2, _) = s.pool.withdraw(&lp2, &sh2, &0, &0);
    assert!(a1 <= 500_000 && a2 <= 500_000, "a1 {a1} a2 {a2}");
    assert!((a1 - a2).abs() <= 1_000);
}

/// MEDIUM-2: a donation (and sync) before the first deposit cannot set the first depositor's price.
#[test]
fn donation_cannot_set_first_price() {
    let s = setup();
    let griefer = Address::generate(&s.e);
    let lp = Address::generate(&s.e);
    fund(&s, &griefer, 1_000_000);
    fund(&s, &lp, 100_000_000);
    TokenClient::new(&s.e, &s.a).transfer(&griefer, &s.pool.address, &1);
    TokenClient::new(&s.e, &s.b).transfer(&griefer, &s.pool.address, &1_000_000);
    assert!(s.pool.try_sync().is_err());
    let (a, b, _) = s.pool.deposit(&lp, &100_000_000, &100_000_000, &0, &0);
    assert_eq!((a, b), (100_000_000, 100_000_000));
    let info = s.pool.info();
    assert_eq!((info.reserve_a, info.reserve_b), (100_000_000, 100_000_000));
    // The donation stays outside the reserves and can be skimmed back.
    s.pool.skim(&griefer);
    assert_eq!(bal(&s, &s.b, &griefer), 1_000_000);
}

/// MEDIUM-3: if one asset's issuer freezes the pool, LPs still get the other asset;
/// the frozen side is owed and claimable once re-authorized.
#[test]
fn frozen_side_is_owed_not_stuck() {
    let s = setup();
    let lp = Address::generate(&s.e);
    let trader = Address::generate(&s.e);
    fund(&s, &lp, 1_000_000);
    fund(&s, &trader, 100_000);
    let (_, _, sh) = s.pool.deposit(&lp, &1_000_000, &1_000_000, &0, &0);
    StellarAssetClient::new(&s.e, &s.a).set_authorized(&s.pool.address, &false);
    let (a, b) = s.pool.withdraw(&lp, &sh, &0, &0);
    assert_eq!(bal(&s, &s.b, &lp), b);
    assert_eq!(bal(&s, &s.a, &lp), 0);
    assert_eq!(s.pool.owed(&lp), (a, 0));
    // Owed tokens are not reserves: they can't be skimmed or swapped out.
    let sink = Address::generate(&s.e);
    StellarAssetClient::new(&s.e, &s.a).set_authorized(&s.pool.address, &true);
    s.pool.skim(&sink);
    assert_eq!(bal(&s, &s.a, &sink), 0);
    assert_eq!(s.pool.claim(&lp), (0, 0));
    assert_eq!(bal(&s, &s.a, &lp), a);
}

/// The pool's locked MINIMUM_LIQUIDITY cannot be moved or withdrawn by an outsider.
#[test]
fn locked_liquidity_not_movable() {
    let s = setup();
    let lp = Address::generate(&s.e);
    let thief = Address::generate(&s.e);
    fund(&s, &lp, 1_000_000);
    s.pool.deposit(&lp, &1_000_000, &1_000_000, &0, &0);
    s.e.set_auths(&[]); // real auth from here on
    let me = s.pool.address.clone();
    assert!(s.pool.try_withdraw(&me, &MINIMUM_LIQUIDITY, &0, &0).is_err());
    assert!(s.pool.try_transfer(&me, &thief, &MINIMUM_LIQUIDITY).is_err());
    assert!(s.pool.try_approve(&me, &thief, &MINIMUM_LIQUIDITY, &1000).is_err());
}

/// Upgrade a live v1 pool (frozen release binary) to the current code in place:
/// reserves, LP balances and funds survive; migrate drops the v1 buffer; TWAP keeps working.
#[test]
fn upgrade_v1_pool_in_place() {
    use soroban_sdk::testutils::Ledger;
    let e = Env::default();
    e.mock_all_auths();
    e.cost_estimate().budget().reset_unlimited();
    let admin = Address::generate(&e);
    let lp = Address::generate(&e);
    let (a, b) = tokens(&e, &admin);
    StellarAssetClient::new(&e, &a).mint(&lp, &1_000_000_000);
    StellarAssetClient::new(&e, &b).mint(&lp, &1_000_000_000);
    e.ledger().set_timestamp(1_000);
    let id = e.register(v1::WASM, (&admin, &a, &b, 30u32));
    let old = v1::Client::new(&e, &id);
    let (_, _, shares) = old.deposit(&lp, &100_000_000, &200_000_000, &0, &0);
    assert_eq!(old.version(), 1);

    let hash = e.deployer().upload_contract_wasm(current::WASM);
    old.upgrade(&admin, &hash);
    let pool = current::Client::new(&e, &id);
    pool.migrate(&admin);
    assert_eq!(pool.version(), VERSION);
    assert_eq!(pool.balance(&lp), shares);
    let info = pool.info();
    assert_eq!((info.reserve_a, info.reserve_b), (100_000_000, 200_000_000));

    e.ledger().set_timestamp(1_100);
    pool.swap(&lp, &lp, &a, &1_000, &0); // writes the first v2 observation
    e.ledger().set_timestamp(1_800);
    let (pa, _, dt) = pool.twap(&600);
    assert_eq!(dt, 700);
    assert!((pa - 2 * PRICE_SCALE).abs() < PRICE_SCALE / 1_000);
    pool.withdraw(&lp, &shares, &0, &0);
}
