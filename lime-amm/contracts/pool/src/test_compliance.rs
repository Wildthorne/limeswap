#![cfg(test)]
//! v3 compliance mode (regulated assets) and the v2 → v3 upgrade.
extern crate std;

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Events, IssuerFlags},
    token::StellarAssetClient,
    Address, Env,
};

mod v2 {
    soroban_sdk::contractimport!(file = "../../releases/lime_amm_pool_v2.wasm");
}
mod current {
    soroban_sdk::contractimport!(file = "../../target/wasm32v1-none/release/lime_amm_pool.wasm");
}

/// Token A plays the regulated asset (think LFUND), token B a free one (think XLM).
struct S {
    e: Env,
    a: Address,
    b: Address,
    issuer: Address,
    pool: LimeSwapPoolClient<'static>,
}

fn setup_with(required: bool) -> S {
    let e = Env::default();
    e.mock_all_auths();
    e.cost_estimate().budget().reset_unlimited();
    let issuer = Address::generate(&e);
    let mk = |e: &Env, reg: bool| {
        let sac = e.register_stellar_asset_contract_v2(issuer.clone());
        sac.issuer().set_flag(IssuerFlags::RevocableFlag);
        sac.issuer().set_flag(IssuerFlags::ClawbackEnabledFlag);
        if reg && required {
            sac.issuer().set_flag(IssuerFlags::RequiredFlag);
        }
        sac.address()
    };
    // Mint the regulated asset first so it's "token A" only if it sorts first; otherwise swap roles.
    let (t1, t2) = (mk(&e, true), mk(&e, false));
    let (a, b) = if t1 < t2 { (t1, t2) } else { (t2, t1) };
    let id = e.register(LimeSwapPool, (&issuer, &a, &b, 30u32));
    let pool = LimeSwapPoolClient::new(&e, &id);
    if required {
        sac(&e, &a).set_authorized(&id, &true);
    }
    S { e, a, b, issuer, pool }
}

fn sac<'a>(e: &'a Env, t: &Address) -> StellarAssetClient<'a> {
    StellarAssetClient::new(e, t)
}

fn bal(s: &S, t: &Address, who: &Address) -> i128 {
    TokenClient::new(&s.e, t).balance(who)
}

/// A new holder of both tokens with an authorized trustline, with a deposited LP position.
fn lp(s: &S, amount: i128) -> (Address, i128) {
    let who = Address::generate(&s.e);
    sac(&s.e, &s.a).set_authorized(&who, &true);
    sac(&s.e, &s.a).mint(&who, &amount);
    sac(&s.e, &s.b).mint(&who, &amount);
    let (_, _, shares) = s.pool.deposit(&who, &amount, &amount, &0, &0);
    (who, shares)
}

/// The contract error code a failed `try_*` call ended with.
fn err<T, C, I>(r: Result<Result<T, C>, Result<soroban_sdk::Error, I>>) -> PoolError {
    match r {
        Err(Ok(e)) => {
            for p in [PoolError::InvalidToken, PoolError::InsufficientShares, PoolError::NotAuthorizedHolder,
                      PoolError::NotIssuer, PoolError::NotRegulated, PoolError::InvalidRecipient] {
                if e == soroban_sdk::Error::from_contract_error(p as u32) {
                    return p;
                }
            }
            panic!("unexpected error {e:?}")
        }
        _ => panic!("expected a pool error"),
    }
}

#[test]
fn off_by_default_lp_moves_freely() {
    let s = setup_with(false);
    let (maria, shares) = lp(&s, 1_000_000);
    sac(&s.e, &s.a).set_authorized(&maria, &false);
    let friend = Address::generate(&s.e);
    s.pool.transfer(&maria, &friend, &shares); // v2 behaviour: the freeze is bypassed via the LP share
    assert_eq!(s.pool.balance(&friend), shares);
    assert_eq!(s.pool.compliance(), (false, false));
}

#[test]
fn only_the_issuer_switches_it_on() {
    let s = setup_with(false);
    s.pool.set_compliance(&s.a, &true);
    assert_eq!(s.e.auths()[0].0, s.issuer);
    assert_eq!(s.pool.compliance(), (true, false));
    let other = Address::generate(&s.e);
    assert_eq!(err(s.pool.try_set_compliance(&other, &true)), PoolError::InvalidToken);
}

#[test]
fn frozen_holder_cannot_move_lp_shares() {
    let s = setup_with(false);
    let (maria, shares) = lp(&s, 1_000_000);
    let (bob, _) = lp(&s, 1_000_000);
    s.pool.set_compliance(&s.a, &true);
    sac(&s.e, &s.a).set_authorized(&maria, &false);
    // Maria can't sell her claim on the frozen asset...
    assert_eq!(err(s.pool.try_transfer(&maria, &bob, &shares)), PoolError::NotAuthorizedHolder);
    s.pool.approve(&maria, &bob, &shares, &1_000);
    assert_eq!(err(s.pool.try_transfer_from(&bob, &maria, &bob, &shares)), PoolError::NotAuthorizedHolder);
    // ...nor receive one, nor add liquidity.
    assert_eq!(err(s.pool.try_transfer(&bob, &maria, &1)), PoolError::NotAuthorizedHolder);
    assert_eq!(err(s.pool.try_deposit(&maria, &10, &10, &0, &0)), PoolError::NotAuthorizedHolder);
    // Unfreezing restores everything.
    sac(&s.e, &s.a).set_authorized(&maria, &true);
    s.pool.transfer(&maria, &bob, &shares);
}

#[test]
fn auth_required_asset_needs_authorized_receivers() {
    let s = setup_with(true);
    let (maria, shares) = lp(&s, 1_000_000);
    s.pool.set_compliance(&s.a, &true);
    let stranger = Address::generate(&s.e); // never KYC'd: no authorized balance
    assert_eq!(err(s.pool.try_transfer(&maria, &stranger, &shares)), PoolError::NotAuthorizedHolder);
    sac(&s.e, &s.a).set_authorized(&stranger, &true);
    s.pool.transfer(&maria, &stranger, &shares);
    assert_eq!(s.pool.balance(&stranger), shares);
}

#[test]
fn frozen_holder_withdrawal_is_held_until_unfrozen() {
    let s = setup_with(false);
    let (maria, shares) = lp(&s, 1_000_000);
    s.pool.set_compliance(&s.a, &true);
    sac(&s.e, &s.a).set_authorized(&maria, &false);
    let b_before = bal(&s, &s.b, &maria);
    let (out_a, out_b) = s.pool.withdraw(&maria, &shares, &0, &0);
    assert_eq!(bal(&s, &s.b, &maria), b_before); // nothing paid, not even the free side
    assert_eq!(s.pool.owed(&maria), (out_a, out_b));
    assert_eq!(err(s.pool.try_claim(&maria)), PoolError::NotAuthorizedHolder);
    sac(&s.e, &s.a).set_authorized(&maria, &true);
    assert_eq!(s.pool.claim(&maria), (0, 0));
    assert_eq!(bal(&s, &s.a, &maria), out_a);
    assert_eq!(bal(&s, &s.b, &maria), b_before + out_b);
}

/// Review H1: a friend swaps the free token in and the frozen one out, then the frozen holder
/// withdraws. With "pay the free side" she'd have sold her frozen asset; now nothing leaves.
#[test]
fn frozen_holder_cannot_cash_out_through_a_friendly_swap() {
    let s = setup_with(false);
    let (maria, shares) = lp(&s, 1_000_000);
    s.pool.set_compliance(&s.a, &true);
    sac(&s.e, &s.a).set_authorized(&maria, &false);
    let friend = Address::generate(&s.e);
    sac(&s.e, &s.a).set_authorized(&friend, &true);
    sac(&s.e, &s.b).mint(&friend, &3_000_000);
    s.pool.swap(&friend, &friend, &s.b, &3_000_000, &0); // pool is now mostly token B
    let b_before = bal(&s, &s.b, &maria);
    s.pool.withdraw(&maria, &shares, &0, &0);
    assert_eq!(bal(&s, &s.b, &maria), b_before);
    let (owed_a, owed_b) = s.pool.owed(&maria);
    assert!(owed_b > 3_000_000 && owed_a > 0);
}

/// Review M1: a custom token with an `admin()` function is not an issuer.
#[test]
fn custom_token_admin_is_not_an_issuer() {
    let e = Env::default();
    e.mock_all_auths();
    let admin = Address::generate(&e);
    let fake = e.register(FakeToken, (&admin,));
    let real = e.register_stellar_asset_contract_v2(admin.clone()).address();
    let (a, b) = if fake < real { (fake.clone(), real) } else { (real, fake.clone()) };
    let pool = LimeSwapPoolClient::new(&e, &e.register(LimeSwapPool, (&admin, &a, &b, 30u32)));
    assert_eq!(err(pool.try_set_compliance(&fake, &true)), PoolError::NotIssuer);
}

#[soroban_sdk::contract]
struct FakeToken;

#[soroban_sdk::contractimpl]
impl FakeToken {
    pub fn __constructor(e: Env, admin: Address) {
        e.storage().instance().set(&0u32, &admin);
    }
    pub fn admin(e: Env) -> Address {
        e.storage().instance().get(&0u32).unwrap()
    }
}

/// Review L1/L2: neither seized tokens nor LP shares can be sent to the pool itself.
#[test]
fn nothing_is_sent_to_the_pool_itself() {
    let s = setup_with(false);
    let (maria, shares) = lp(&s, 500_000);
    assert_eq!(err(s.pool.try_transfer(&maria, &s.pool.address, &1)), PoolError::InvalidRecipient);
    s.pool.approve(&maria, &maria, &shares, &1_000);
    assert_eq!(err(s.pool.try_transfer_from(&maria, &maria, &s.pool.address, &1)), PoolError::InvalidRecipient);
    s.pool.set_compliance(&s.a, &true);
    assert_eq!(err(s.pool.try_force_redeem(&s.a, &maria, &s.pool.address, &true)), PoolError::InvalidRecipient);
}

#[test]
fn force_redeem_takes_back_only_the_issuers_asset() {
    let s = setup_with(false);
    let (bob, bob_shares) = lp(&s, 1_000_000);
    let (maria, shares) = lp(&s, 500_000);
    s.pool.set_compliance(&s.a, &true);
    sac(&s.e, &s.a).set_authorized(&maria, &false);
    let vault = Address::generate(&s.e);
    sac(&s.e, &s.a).set_authorized(&vault, &true);

    let before = s.pool.info();
    let (burned, seized) = s.pool.force_redeem(&s.a, &maria, &vault, &true);
    assert_eq!(burned, shares);
    assert_eq!(s.pool.balance(&maria), 0);
    assert_eq!(bal(&s, &s.a, &vault), seized);
    assert!((seized - 500_000).abs() <= 1);
    assert!((bal(&s, &s.b, &maria) - 500_000).abs() <= 1); // Maria keeps the free asset
    // Bob's position is untouched: same value per share.
    let after = s.pool.info();
    assert_eq!(after.reserve_a * before.total_shares / after.total_shares, before.reserve_a);
    let (ba, bb) = s.pool.withdraw(&bob, &bob_shares, &0, &0);
    assert!((ba - 1_000_000).abs() <= 1_000 && (bb - 1_000_000).abs() <= 1_000);
}

#[test]
fn force_redeem_can_hold_the_other_side() {
    let s = setup_with(false);
    let (maria, _) = lp(&s, 500_000);
    lp(&s, 500_000);
    s.pool.set_compliance(&s.a, &true);
    sac(&s.e, &s.a).set_authorized(&maria, &false);
    let b_before = bal(&s, &s.b, &maria);
    s.pool.force_redeem(&s.a, &maria, &s.issuer, &false);
    assert_eq!(bal(&s, &s.b, &maria), b_before);
    let (oa, ob) = s.pool.owed(&maria);
    assert_eq!(oa, 0);
    assert!((ob - 500_000).abs() <= MINIMUM_LIQUIDITY); // first depositor: 1,000 units locked
    let info = s.pool.info();
    assert_eq!(bal(&s, &s.b, &s.pool.address), info.reserve_b + ob);
}

#[test]
fn force_redeem_also_sweeps_owed_balance() {
    let s = setup_with(false);
    let (maria, shares) = lp(&s, 500_000);
    lp(&s, 500_000);
    s.pool.set_compliance(&s.a, &true);
    sac(&s.e, &s.a).set_authorized(&maria, &false);
    let half = shares / 2;
    let (owed_a, owed_b) = s.pool.withdraw(&maria, &half, &0, &0); // held: frozen
    let vault = Address::generate(&s.e);
    let (_, seized) = s.pool.force_redeem(&s.a, &maria, &vault, &true);
    assert!(seized > owed_a);
    assert_eq!(s.pool.owed(&maria), (0, owed_b)); // her B stays held until she's unfrozen
    assert_eq!(bal(&s, &s.a, &vault), seized);
    // Pool still holds exactly reserves + owed of everyone else (none).
    let info = s.pool.info();
    assert_eq!(bal(&s, &s.a, &s.pool.address), info.reserve_a);
}

#[test]
fn force_redeem_needs_compliance_mode() {
    let s = setup_with(false);
    let (maria, _) = lp(&s, 500_000);
    assert_eq!(err(s.pool.try_force_redeem(&s.a, &maria, &s.issuer, &true)), PoolError::NotRegulated);
    s.pool.set_compliance(&s.a, &true);
    let nobody = Address::generate(&s.e);
    assert_eq!(err(s.pool.try_force_redeem(&s.a, &nobody, &s.issuer, &true)), PoolError::InsufficientShares);
}

#[test]
fn withdraw_emits_burn_event() {
    let s = setup_with(false);
    let (maria, shares) = lp(&s, 500_000);
    s.pool.withdraw(&maria, &shares, &0, &0);
    // SEP-41 indexers track supply from mint/burn events; v1–v2 burned shares silently.
    let events = std::format!("{:?}", s.e.events().all());
    assert!(events.contains("burn"), "no burn event");
}

/// Upgrade a live v2 pool to v3 in place: positions survive, compliance starts off.
#[test]
fn upgrade_v2_pool_in_place() {
    let e = Env::default();
    e.mock_all_auths();
    e.cost_estimate().budget().reset_unlimited();
    let admin = Address::generate(&e);
    let holder = Address::generate(&e);
    let mk = |e: &Env| e.register_stellar_asset_contract_v2(admin.clone()).address();
    let (t1, t2) = (mk(&e), mk(&e));
    let (a, b) = if t1 < t2 { (t1, t2) } else { (t2, t1) };
    sac(&e, &a).mint(&holder, &1_000_000);
    sac(&e, &b).mint(&holder, &1_000_000);
    let id = e.register(v2::WASM, (&admin, &a, &b, 30u32));
    let old = v2::Client::new(&e, &id);
    let (_, _, shares) = old.deposit(&holder, &1_000_000, &1_000_000, &0, &0);
    old.upgrade(&admin, &e.deployer().upload_contract_wasm(current::WASM));
    let pool = current::Client::new(&e, &id);
    assert_eq!(pool.version(), VERSION);
    assert_eq!(pool.compliance(), (false, false));
    assert_eq!(pool.balance(&holder), shares);
    pool.withdraw(&holder, &shares, &0, &0);
}
