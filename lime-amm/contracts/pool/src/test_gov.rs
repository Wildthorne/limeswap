#![cfg(test)]
//! v5 governance: two-step admin transfer, pause-only guardian, and the v4 → v5 upgrade.
extern crate std;

use super::*;
use soroban_sdk::{testutils::Address as _, token::StellarAssetClient, Address, Env};

mod v4 {
    soroban_sdk::contractimport!(file = "../../releases/lime_amm_pool_v4.wasm");
}
mod current {
    soroban_sdk::contractimport!(file = "../../target/wasm32v1-none/release/lime_amm_pool.wasm");
}

fn tokens(e: &Env, admin: &Address) -> (Address, Address) {
    let mk = || e.register_stellar_asset_contract_v2(admin.clone()).address();
    let (t1, t2) = (mk(), mk());
    if t1 < t2 { (t1, t2) } else { (t2, t1) }
}

fn code<T: core::fmt::Debug, C, I: core::fmt::Debug>(r: Result<Result<T, C>, Result<soroban_sdk::Error, I>>) -> soroban_sdk::Error {
    match r {
        Err(Ok(e)) => e,
        other => panic!("expected a contract error, got {:?}", other.map(|_| ()).map_err(|e| e.err())),
    }
}

#[test]
fn two_step_admin_transfer_and_guardian() {
    let e = Env::default();
    e.mock_all_auths();
    let admin = Address::generate(&e);
    let (a, b) = tokens(&e, &admin);
    let pool = LimeSwapPoolClient::new(&e, &e.register(LimeSwapPool, (&admin, &a, &b, 30u32)));
    let next = Address::generate(&e);
    let typo = Address::generate(&e);
    let guardian = Address::generate(&e);
    let unauthorized: soroban_sdk::Error = PoolError::Unauthorized.into();

    let stranger = Address::generate(&e);
    assert_eq!(code(pool.try_propose_admin(&stranger, &stranger)), unauthorized);
    pool.propose_admin(&admin, &typo);
    // A typo can't take over by itself being proposed; it has to accept, and only it can.
    assert_eq!(pool.admin(), admin);
    assert_eq!(code(pool.try_accept_admin(&next)), unauthorized);
    pool.propose_admin(&admin, &next); // the admin fixes the typo
    assert_eq!(code(pool.try_accept_admin(&typo)), unauthorized);
    pool.accept_admin(&next);
    assert_eq!((pool.admin(), pool.pending_admin()), (next.clone(), None));
    assert_eq!(code(pool.try_accept_admin(&next)), unauthorized); // one-shot

    // Old key: no more upgrade / pause / migrate.
    let hash = BytesN::from_array(&e, &[0u8; 32]);
    assert_eq!(code(pool.try_upgrade(&admin, &hash)), unauthorized);
    assert_eq!(code(pool.try_pause(&admin)), unauthorized);
    assert_eq!(code(pool.try_migrate(&admin)), unauthorized);

    // Guardian: pause, nothing else.
    pool.set_guardian(&next, &Some(guardian.clone()));
    pool.pause(&guardian);
    assert!(pool.paused());
    assert_eq!(code(pool.try_unpause(&guardian)), unauthorized);
    assert_eq!(code(pool.try_upgrade(&guardian, &hash)), unauthorized);
    assert_eq!(code(pool.try_set_guardian(&guardian, &None)), unauthorized);
    pool.unpause(&next);
    pool.set_guardian(&next, &None);
    assert_eq!(pool.guardian(), None);
    assert_eq!(code(pool.try_pause(&guardian)), unauthorized);
}

/// Upgrade a live v4 pool to v5 in place (frozen release binary): positions survive, admin
/// unchanged, no guardian, and the new admin flow works.
#[test]
fn upgrade_v4_pool_in_place() {
    let e = Env::default();
    e.mock_all_auths();
    e.cost_estimate().budget().reset_unlimited();
    let admin = Address::generate(&e);
    let holder = Address::generate(&e);
    let (a, b) = tokens(&e, &admin);
    StellarAssetClient::new(&e, &a).mint(&holder, &10_000_000);
    StellarAssetClient::new(&e, &b).mint(&holder, &10_000_000);
    let id = e.register(v4::WASM, (&admin, &a, &b, 30u32));
    let old = v4::Client::new(&e, &id);
    let (_, _, shares) = old.deposit(&holder, &1_000_000, &1_000_000, &0, &0);
    old.swap(&holder, &holder, &a, &10_000, &0);
    let before = old.info();
    old.upgrade(&admin, &e.deployer().upload_contract_wasm(current::WASM));
    old.migrate(&admin); // what upgrade-pools.sh does; a no-op after v1

    let pool = current::Client::new(&e, &id);
    assert_eq!(pool.version(), 5);
    let after = pool.info();
    assert_eq!((after.reserve_a, after.reserve_b, after.total_shares), (before.reserve_a, before.reserve_b, before.total_shares));
    assert_eq!(pool.balance(&holder), shares);
    assert_eq!((pool.admin(), pool.pending_admin(), pool.guardian()), (admin.clone(), None, None));
    pool.swap(&holder, &holder, &b, &10_000, &0);
    let next = Address::generate(&e);
    pool.propose_admin(&admin, &next);
    pool.accept_admin(&next);
    assert_eq!(pool.admin(), next);
    pool.withdraw(&holder, &shares, &0, &0);
}
