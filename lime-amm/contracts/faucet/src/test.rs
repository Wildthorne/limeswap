#![cfg(test)]
extern crate std;

use super::*;
use soroban_sdk::{testutils::{Address as _, Ledger}, token::StellarAssetClient, vec, Address, Env};

fn setup() -> (Env, FaucetClient<'static>, Address, Address, Address) {
    let e = Env::default();
    e.mock_all_auths();
    e.ledger().set_timestamp(1_000);
    let admin = Address::generate(&e);
    let a = e.register_stellar_asset_contract_v2(admin.clone()).address();
    let b = e.register_stellar_asset_contract_v2(admin.clone()).address();
    let drips = vec![&e, Drip { token: a.clone(), amount: 100 }, Drip { token: b.clone(), amount: 50 }];
    let id = e.register(Faucet, (&admin, drips, 86_400u64));
    StellarAssetClient::new(&e, &a).mint(&id, &1_000);
    StellarAssetClient::new(&e, &b).mint(&id, &60);
    let f = FaucetClient::new(&e, &id);
    (e, f, admin, a, b)
}

#[test]
fn claim_pays_every_drip_once_per_cooldown() {
    let (e, f, _, a, b) = setup();
    let user = Address::generate(&e);
    assert_eq!(f.next_claim(&user), 0);
    f.claim(&user);
    assert_eq!(TokenClient::new(&e, &a).balance(&user), 100);
    assert_eq!(TokenClient::new(&e, &b).balance(&user), 50);
    assert_eq!(f.next_claim(&user), 1_000 + 86_400);
    assert_eq!(f.try_claim(&user), Err(Ok(FaucetError::TooSoon.into())));
    e.ledger().set_timestamp(1_000 + 86_400);
    // b now holds 10 < 50: the whole claim reverts, a is not paid either.
    assert_eq!(f.try_claim(&user), Err(Ok(FaucetError::Empty.into())));
    assert_eq!(TokenClient::new(&e, &a).balance(&user), 100);
}

#[test]
fn only_admin_changes_drips_and_withdraws() {
    let (e, f, admin, a, _) = setup();
    let other = Address::generate(&e);
    assert_eq!(f.try_set_drips(&other, &vec![&e, Drip { token: a.clone(), amount: 1 }], &1), Err(Ok(FaucetError::Unauthorized.into())));
    assert_eq!(f.try_set_drips(&admin, &vec![&e, Drip { token: a.clone(), amount: 0 }], &1), Err(Ok(FaucetError::InvalidDrip.into())));
    f.set_drips(&admin, &vec![&e, Drip { token: a.clone(), amount: 7 }], &60);
    assert_eq!(f.cooldown(), 60);
    f.withdraw(&admin, &a, &500, &admin);
    assert_eq!(TokenClient::new(&e, &a).balance(&admin), 500);
    assert!(f.try_withdraw(&other, &a, &1, &other).is_err());
}

#[test]
fn claim_needs_the_claimers_signature() {
    let (e, f, _, _, _) = setup();
    let user = Address::generate(&e);
    e.set_auths(&[]);
    assert!(f.try_claim(&user).is_err());
}
