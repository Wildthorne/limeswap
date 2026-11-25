#![cfg(test)]
extern crate std;

use super::*;
use soroban_sdk::{testutils::Address as _, Address, Env};

mod pool {
    soroban_sdk::contractimport!(file = "../../target/wasm32v1-none/release/lime_amm_pool.wasm");
}

fn setup() -> (Env, Address, LimeSwapFactoryClient<'static>, Address, Address) {
    let e = Env::default();
    e.mock_all_auths();
    let admin = Address::generate(&e);
    let wasm = e.deployer().upload_contract_wasm(pool::WASM);
    let id = e.register(LimeSwapFactory, (&admin, wasm));
    let f = LimeSwapFactoryClient::new(&e, &id);
    let x = e.register_stellar_asset_contract_v2(admin.clone()).address();
    let y = e.register_stellar_asset_contract_v2(admin.clone()).address();
    (e, admin, f, x, y)
}

#[test]
fn create_and_lookup_in_any_order() {
    let (e, admin, f, x, y) = setup();
    let p = f.create_pool(&y, &x, &30);
    assert_eq!(f.get_pool(&x, &y, &30), Some(p.clone()));
    assert_eq!(f.get_pool(&y, &x, &30), Some(p.clone()));
    assert_eq!(f.get_pool(&x, &y, &5), None);
    let info = pool::Client::new(&e, &p).info();
    let (a, b) = sort(x, y);
    assert_eq!((info.token_a, info.token_b, info.fee_bps), (a, b, 30));
    assert_eq!(pool::Client::new(&e, &p).admin(), admin);
}

#[test]
fn one_pool_per_fee_tier() {
    let (_e, _admin, f, x, y) = setup();
    let p30 = f.create_pool(&x, &y, &30);
    let p5 = f.create_pool(&x, &y, &5);
    assert_ne!(p30, p5);
    assert_eq!(f.pool_count(), 2);
    assert_eq!(f.pools(&0, &10).len(), 2);
    assert_eq!(f.pools(&1, &10).get(0), Some(p5));
    assert_eq!(f.try_create_pool(&y, &x, &30), Err(Ok(FactoryError::PoolExists.into())));
}

#[test]
fn rejects_bad_input() {
    let (_e, _admin, f, x, y) = setup();
    assert_eq!(f.try_create_pool(&x, &y, &42), Err(Ok(FactoryError::InvalidFee.into())));
    assert_eq!(f.try_create_pool(&x, &x, &30), Err(Ok(FactoryError::SameToken.into())));
}

#[test]
fn only_admin_sets_wasm() {
    let (e, _admin, f, _x, _y) = setup();
    let stranger = Address::generate(&e);
    let hash = f.pool_wasm_hash();
    assert_eq!(f.try_set_pool_wasm(&stranger, &hash), Err(Ok(FactoryError::Unauthorized.into())));
}

mod factory_v1 {
    soroban_sdk::contractimport!(file = "../../releases/lime_amm_factory_v1.wasm");
}

#[test]
fn two_step_admin_and_new_pools_get_the_current_admin() {
    let (e, admin, f, x, y) = setup();
    let old_pool = f.create_pool(&x, &y, &30);
    let next = Address::generate(&e);
    let stranger = Address::generate(&e);
    let unauthorized = Err(Ok(FactoryError::Unauthorized.into()));
    assert_eq!(f.try_propose_admin(&stranger, &next), unauthorized);
    f.propose_admin(&admin, &next);
    assert_eq!((f.admin(), f.pending_admin()), (admin.clone(), Some(next.clone())));
    assert_eq!(f.try_accept_admin(&stranger), unauthorized);
    f.accept_admin(&next);
    assert_eq!((f.admin(), f.pending_admin()), (next.clone(), None));
    let hash = f.pool_wasm_hash();
    assert_eq!(f.try_set_pool_wasm(&admin, &hash), unauthorized);
    assert_eq!(f.try_upgrade(&admin, &hash), unauthorized);
    // New pools are born with the factory's current admin; old pools keep theirs.
    let new_pool = f.create_pool(&x, &y, &5);
    assert_eq!(pool::Client::new(&e, &new_pool).admin(), next);
    assert_eq!(pool::Client::new(&e, &old_pool).admin(), admin);
}

/// Upgrade the frozen v1 factory to v2 in place: registry intact, admin unchanged.
#[test]
fn upgrade_v1_factory_in_place() {
    let e = Env::default();
    e.mock_all_auths();
    let admin = Address::generate(&e);
    let wasm = e.deployer().upload_contract_wasm(pool::WASM);
    let id = e.register(factory_v1::WASM, (&admin, wasm));
    let old = factory_v1::Client::new(&e, &id);
    let x = e.register_stellar_asset_contract_v2(admin.clone()).address();
    let y = e.register_stellar_asset_contract_v2(admin.clone()).address();
    let p = old.create_pool(&x, &y, &30);
    old.upgrade(&admin, &e.deployer().upload_contract_wasm(include_bytes!("../../../target/wasm32v1-none/release/lime_amm_factory.wasm").as_slice()));
    let f = LimeSwapFactoryClient::new(&e, &id);
    assert_eq!(f.version(), 2);
    assert_eq!((f.admin(), f.pending_admin()), (admin, None));
    assert_eq!(f.get_pool(&y, &x, &30), Some(p));
    assert_eq!(f.pool_count(), 1);
    f.create_pool(&x, &y, &100);
}
