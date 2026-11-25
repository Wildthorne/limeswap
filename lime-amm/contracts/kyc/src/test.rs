#![cfg(test)]
extern crate std;

use super::*;
use lime_amm_pool::{LimeSwapPool, LimeSwapPoolClient};
use soroban_sdk::{
    testutils::{Address as _, IssuerFlags},
    token::TokenClient,
    Address, Env,
};

struct S {
    e: Env,
    issuer: Address,
    lfund: Address,
    desk: KycDeskClient<'static>,
}

/// LFUND-like asset (auth required, revocable, clawback) whose SAC admin is handed to the desk.
fn setup() -> S {
    let e = Env::default();
    e.mock_all_auths();
    e.cost_estimate().budget().reset_unlimited();
    let issuer = Address::generate(&e);
    let sac = e.register_stellar_asset_contract_v2(issuer.clone());
    sac.issuer().set_flag(IssuerFlags::RequiredFlag);
    sac.issuer().set_flag(IssuerFlags::RevocableFlag);
    sac.issuer().set_flag(IssuerFlags::ClawbackEnabledFlag);
    let lfund = sac.address();
    let id = e.register(KycDesk, (&issuer, &lfund, 20i128));
    StellarAssetClient::new(&e, &lfund).set_admin(&id);
    let desk = KycDeskClient::new(&e, &id);
    S { e, issuer, lfund, desk }
}

fn token<'a>(s: &'a S) -> TokenClient<'a> {
    TokenClient::new(&s.e, &s.lfund)
}

fn authorized(s: &S, who: &Address) -> bool {
    StellarAssetClient::new(&s.e, &s.lfund).authorized(who)
}

fn err<T, E: core::fmt::Debug>(r: Result<T, Result<soroban_sdk::Error, E>>) -> soroban_sdk::Error {
    match r {
        Err(Ok(e)) => e,
        _ => panic!("expected a contract error"),
    }
}

#[test]
fn verify_approves_pays_the_grant_once() {
    let s = setup();
    let maria = Address::generate(&s.e);
    assert_eq!(s.desk.status(&maria), KycStatus::Unverified);
    assert!(!authorized(&s, &maria));
    assert_eq!(s.desk.verify(&maria), 20);
    // Only Maria's signature was needed: the desk acts as the SAC admin itself.
    assert_eq!(s.e.auths()[0].0, maria);
    assert_eq!(s.e.auths().len(), 1);
    assert!(authorized(&s, &maria));
    assert_eq!(token(&s).balance(&maria), 20);
    assert_eq!(s.desk.status(&maria), KycStatus::Verified);
    assert_eq!(err(s.desk.try_verify(&maria)), KycError::AlreadyVerified.into());
}

#[test]
fn verify_needs_the_users_signature() {
    let s = setup();
    let maria = Address::generate(&s.e);
    s.e.set_auths(&[]);
    assert!(s.desk.try_verify(&maria).is_err());
    assert_eq!(s.desk.status(&maria), KycStatus::Unverified);
}

#[test]
fn a_frozen_account_cannot_self_verify() {
    let s = setup();
    let maria = Address::generate(&s.e);
    let ivan = Address::generate(&s.e);
    s.desk.verify(&maria);
    s.desk.set_status(&maria, &false);
    assert_eq!(s.e.auths()[0].0, s.issuer);
    assert!(!authorized(&s, &maria));
    assert_eq!(s.desk.status(&maria), KycStatus::Revoked);
    assert_eq!(err(s.desk.try_verify(&maria)), KycError::Revoked.into());
    // Frozen tokens can't move.
    assert!(token(&s).try_transfer(&maria, &ivan, &1).is_err());
    // Blocking someone who never held LFUND just records it.
    s.desk.set_status(&ivan, &false);
    assert_eq!(err(s.desk.try_verify(&ivan)), KycError::Revoked.into());
    // The issuer can reinstate.
    s.desk.set_status(&maria, &true);
    assert!(authorized(&s, &maria));
    let carol = Address::generate(&s.e);
    s.desk.verify(&carol);
    token(&s).transfer(&maria, &carol, &1);
    assert_eq!(token(&s).balance(&carol), 21);
}

#[test]
fn issuer_keeps_mint_clawback_and_grant() {
    let s = setup();
    let maria = Address::generate(&s.e);
    s.desk.verify(&maria);
    s.desk.mint(&maria, &100);
    assert_eq!(s.e.auths()[0].0, s.issuer);
    s.desk.clawback(&maria, &30);
    assert_eq!(token(&s).balance(&maria), 90);
    assert_eq!(err(s.desk.try_set_grant(&-1)), KycError::InvalidAmount.into());
    s.desk.set_grant(&0);
    let ivan = Address::generate(&s.e);
    assert_eq!(s.desk.verify(&ivan), 0);
    assert!(authorized(&s, &ivan));
    assert_eq!(token(&s).balance(&ivan), 0);
}

#[test]
fn issuer_functions_need_the_issuers_signature() {
    let s = setup();
    let maria = Address::generate(&s.e);
    s.e.set_auths(&[]);
    assert!(s.desk.try_set_status(&maria, &true).is_err());
    assert!(s.desk.try_mint(&maria, &1).is_err());
    assert!(s.desk.try_set_sac_admin(&maria).is_err());
}

#[test]
fn issuer_can_take_the_admin_role_back() {
    let s = setup();
    s.desk.set_sac_admin(&s.issuer);
    let sac = StellarAssetClient::new(&s.e, &s.lfund);
    assert_eq!(sac.admin(), s.issuer);
    let maria = Address::generate(&s.e);
    assert!(s.desk.try_verify(&maria).is_err());
    sac.set_authorized(&maria, &true);
}

#[test]
fn compliance_pool_powers_go_through_the_desk() {
    let s = setup();
    let xlm = s.e.register_stellar_asset_contract_v2(Address::generate(&s.e)).address();
    let (ta, tb) = if s.lfund < xlm { (s.lfund.clone(), xlm.clone()) } else { (xlm.clone(), s.lfund.clone()) };
    let id = s.e.register(LimeSwapPool, (&s.issuer, &ta, &tb, 30u32));
    let pool = LimeSwapPoolClient::new(&s.e, &id);
    s.desk.set_status(&id, &true);
    // The pool checks the SAC admin, which is now the desk: the issuer's own key is refused.
    s.e.set_auths(&[]);
    assert!(pool.try_set_compliance(&s.lfund, &true).is_err());
    s.e.mock_all_auths();
    s.desk.pool_set_compliance(&id, &true);
    assert_eq!(pool.compliance(), (ta == s.lfund, tb == s.lfund));

    // A self-verified user provides liquidity; the issuer freezes and force-redeems her.
    let maria = Address::generate(&s.e);
    s.desk.verify(&maria);
    s.desk.mint(&maria, &1_000_000);
    StellarAssetClient::new(&s.e, &xlm).mint(&maria, &1_000_000);
    pool.deposit(&maria, &1_000_000, &1_000_000, &0, &0);
    assert!(pool.balance(&maria) > 0);
    s.desk.set_status(&maria, &false);
    // (On Testnet `to` is the issuer's own account, which burns the LFUND; test addresses are
    // contracts, so an approved vault stands in.)
    let vault = Address::generate(&s.e);
    s.desk.set_status(&vault, &true);
    let (seized, released) = s.desk.pool_force_redeem(&id, &maria, &vault, &true);
    assert_eq!(token(&s).balance(&vault), seized);
    assert!(seized > 0 && released > 0);
    assert_eq!(pool.balance(&maria), 0);
    assert_eq!(TokenClient::new(&s.e, &xlm).balance(&maria), released);
}
