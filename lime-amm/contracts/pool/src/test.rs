#![cfg(test)]
extern crate std;

use super::*;
use proptest::prelude::*;
use soroban_sdk::{
    testutils::{Address as _, IssuerFlags, Ledger},
    token::StellarAssetClient,
    Address, Env,
};

struct Setup {
    e: Env,
    admin: Address,
    a: Address,
    b: Address,
    pool: LimeSwapPoolClient<'static>,
}

fn new_token(e: &Env, admin: &Address) -> Address {
    let sac = e.register_stellar_asset_contract_v2(admin.clone());
    sac.issuer().set_flag(IssuerFlags::ClawbackEnabledFlag);
    sac.address()
}

fn setup() -> Setup {
    let e = Env::default();
    e.mock_all_auths();
    e.cost_estimate().budget().reset_unlimited();
    let admin = Address::generate(&e);
    let (mut a, mut b) = (new_token(&e, &admin), new_token(&e, &admin));
    if a > b {
        core::mem::swap(&mut a, &mut b);
    }
    let id = e.register(LimeSwapPool, (&admin, &a, &b, 30u32));
    let pool = LimeSwapPoolClient::new(&e, &id);
    Setup { e, admin, a, b, pool }
}

fn fund(s: &Setup, who: &Address, amount: i128) {
    StellarAssetClient::new(&s.e, &s.a).mint(who, &amount);
    StellarAssetClient::new(&s.e, &s.b).mint(who, &amount);
}

fn bal(s: &Setup, token: &Address, who: &Address) -> i128 {
    TokenClient::new(&s.e, token).balance(who)
}

#[test]
fn first_deposit_locks_minimum_liquidity() {
    let s = setup();
    let lp = Address::generate(&s.e);
    fund(&s, &lp, 1_000_000_000);
    let (a, b, shares) = s.pool.deposit(&lp, &100_000_000, &400_000_000, &0, &0);
    assert_eq!((a, b), (100_000_000, 400_000_000));
    assert_eq!(shares, 200_000_000 - MINIMUM_LIQUIDITY); // sqrt(1e8 * 4e8) = 2e8
    assert_eq!(s.pool.balance(&s.pool.address), MINIMUM_LIQUIDITY);
    assert_eq!(s.pool.total_supply(), 200_000_000);
    let info = s.pool.info();
    assert_eq!((info.reserve_a, info.reserve_b), (100_000_000, 400_000_000));
}

#[test]
fn second_deposit_uses_current_ratio() {
    let s = setup();
    let lp1 = Address::generate(&s.e);
    let lp2 = Address::generate(&s.e);
    fund(&s, &lp1, 1_000_000_000);
    fund(&s, &lp2, 1_000_000_000);
    s.pool.deposit(&lp1, &100_000_000, &400_000_000, &0, &0);
    // Offers too much B: pool takes only 4×A worth of B.
    let (a, b, shares) = s.pool.deposit(&lp2, &10_000_000, &900_000_000, &0, &0);
    assert_eq!((a, b), (10_000_000, 40_000_000));
    assert_eq!(shares, 20_000_000);
}

#[test]
#[should_panic(expected = "Error(Contract, #6)")]
fn deposit_slippage_is_enforced() {
    let s = setup();
    let lp = Address::generate(&s.e);
    fund(&s, &lp, 1_000_000_000);
    s.pool.deposit(&lp, &100_000_000, &400_000_000, &0, &0);
    s.pool.deposit(&lp, &10_000_000, &30_000_000, &0, &35_000_000);
}

#[test]
fn swap_matches_quote_and_classic_formula() {
    let s = setup();
    let lp = Address::generate(&s.e);
    let trader = Address::generate(&s.e);
    fund(&s, &lp, 1_000_000_000);
    StellarAssetClient::new(&s.e, &s.a).mint(&trader, &10_000_000);
    s.pool.deposit(&lp, &100_000_000, &100_000_000, &0, &0);

    let quote = s.pool.get_amount_out(&s.a, &10_000_000);
    // CAP-38: y = (1−F)·Y·x / (X + (1−F)·x) = 0.997e7·1e8 / (1e8 + 0.997e7) = 9066108.9…
    assert_eq!(quote, 9_066_108);
    let out = s.pool.swap(&trader, &trader, &s.a, &10_000_000, &quote);
    assert_eq!(out, quote);
    assert_eq!(bal(&s, &s.b, &trader), quote);
    assert_eq!(bal(&s, &s.a, &trader), 0);
    let info = s.pool.info();
    assert_eq!((info.reserve_a, info.reserve_b), (110_000_000, 100_000_000 - quote));
}

#[test]
#[should_panic(expected = "Error(Contract, #4)")]
fn swap_min_out_is_enforced() {
    let s = setup();
    let lp = Address::generate(&s.e);
    let trader = Address::generate(&s.e);
    fund(&s, &lp, 1_000_000_000);
    fund(&s, &trader, 10_000_000);
    s.pool.deposit(&lp, &100_000_000, &100_000_000, &0, &0);
    s.pool.swap(&trader, &trader, &s.a, &10_000_000, &9_066_109);
}

#[test]
#[should_panic(expected = "Error(Contract, #7)")]
fn swap_raw_rejects_taking_more_than_paid_for() {
    let s = setup();
    let lp = Address::generate(&s.e);
    let trader = Address::generate(&s.e);
    fund(&s, &lp, 1_000_000_000);
    fund(&s, &trader, 10_000_000);
    s.pool.deposit(&lp, &100_000_000, &100_000_000, &0, &0);
    TokenClient::new(&s.e, &s.a).transfer(&trader, &s.pool.address, &10_000_000);
    s.pool.swap_raw(&0, &9_066_109, &trader); // 1 stroop more than the fair output
}

#[test]
fn swap_raw_router_style() {
    let s = setup();
    let lp = Address::generate(&s.e);
    let trader = Address::generate(&s.e);
    fund(&s, &lp, 1_000_000_000);
    fund(&s, &trader, 10_000_000);
    s.pool.deposit(&lp, &100_000_000, &100_000_000, &0, &0);
    TokenClient::new(&s.e, &s.a).transfer(&trader, &s.pool.address, &10_000_000);
    s.pool.swap_raw(&0, &9_066_108, &trader);
    assert_eq!(bal(&s, &s.b, &trader), 10_000_000 + 9_066_108);
}

#[test]
fn withdraw_returns_pro_rata_including_fees() {
    let s = setup();
    let lp = Address::generate(&s.e);
    let trader = Address::generate(&s.e);
    fund(&s, &lp, 1_000_000_000);
    fund(&s, &trader, 100_000_000);
    let (_, _, shares) = s.pool.deposit(&lp, &100_000_000, &100_000_000, &0, &0);
    // Round trip: fees stay in the pool.
    let out = s.pool.swap(&trader, &trader, &s.a, &50_000_000, &0);
    s.pool.swap(&trader, &trader, &s.b, &out, &0);
    let (a, b) = s.pool.withdraw(&lp, &shares, &0, &0);
    assert!(a + b > 2 * (100_000_000 - MINIMUM_LIQUIDITY), "LP earned fees: {a} + {b}");
    assert_eq!(s.pool.balance(&lp), 0);
}

#[test]
fn pause_blocks_swaps_but_not_withdrawals() {
    let s = setup();
    let lp = Address::generate(&s.e);
    fund(&s, &lp, 1_000_000_000);
    let (_, _, shares) = s.pool.deposit(&lp, &100_000_000, &100_000_000, &0, &0);
    s.pool.pause(&s.admin);
    assert!(s.pool.try_swap(&lp, &lp, &s.a, &1_000, &0).is_err());
    assert!(s.pool.try_deposit(&lp, &1_000, &1_000, &0, &0).is_err());
    s.pool.withdraw(&lp, &shares, &0, &0);
    s.pool.unpause(&s.admin);
}

#[test]
#[should_panic(expected = "Error(Contract, #1)")]
fn only_admin_can_pause() {
    let s = setup();
    let stranger = Address::generate(&s.e);
    s.pool.pause(&stranger);
}

#[test]
fn sync_after_balance_drop_and_skim_after_donation() {
    let s = setup();
    let lp = Address::generate(&s.e);
    let donor = Address::generate(&s.e);
    let sink = Address::generate(&s.e);
    fund(&s, &lp, 1_000_000_000);
    fund(&s, &donor, 5_000);
    s.pool.deposit(&lp, &100_000_000, &100_000_000, &0, &0);
    TokenClient::new(&s.e, &s.a).transfer(&donor, &s.pool.address, &5_000);
    s.pool.skim(&sink);
    assert_eq!(bal(&s, &s.a, &sink), 5_000);
    // Simulate an issuer clawback from the pool (SAC admin clawback).
    StellarAssetClient::new(&s.e, &s.a).clawback(&s.pool.address, &1_000_000);
    s.pool.sync();
    assert_eq!(s.pool.info().reserve_a, 99_000_000);
}

#[test]
fn twap_averages_over_time() {
    let s = setup();
    let lp = Address::generate(&s.e);
    let trader = Address::generate(&s.e);
    fund(&s, &lp, 1_000_000_000);
    fund(&s, &trader, 1_000_000_000);
    s.e.ledger().set_timestamp(1_000);
    s.pool.deposit(&lp, &100_000_000, &200_000_000, &0, &0); // price_a = 2.0
    assert!(s.pool.try_twap(&600).is_err()); // no history yet

    // 600 s at price 2.0, then a big swap moves the price, then 600 s at the new price.
    s.e.ledger().set_timestamp(1_600);
    s.pool.swap(&trader, &trader, &s.b, &200_000_000, &0);
    let info = s.pool.info();
    let new_price = info.reserve_b * PRICE_SCALE / info.reserve_a;
    s.e.ledger().set_timestamp(2_200);
    let (pa, _, dt) = s.pool.twap(&1_200);
    assert_eq!(dt, 1_200);
    let expected = (2 * PRICE_SCALE + new_price) / 2;
    assert!((pa - expected).abs() <= 2, "twap {pa} vs {expected}");
    // A short window that starts after the swap sees only the new price.
    s.e.ledger().set_timestamp(2_500);
    let (pa_short, _, _) = s.pool.twap(&600);
    assert!((pa_short - new_price).abs() <= 2);
}

#[test]
fn lp_token_is_transferable_sep41() {
    let s = setup();
    let lp = Address::generate(&s.e);
    let friend = Address::generate(&s.e);
    fund(&s, &lp, 1_000_000_000);
    let (_, _, shares) = s.pool.deposit(&lp, &100_000_000, &100_000_000, &0, &0);
    s.pool.transfer(&lp, &MuxedAddress::from(friend.clone()), &shares);
    assert_eq!(s.pool.balance(&friend), shares);
    assert_eq!(s.pool.symbol(), String::from_str(&s.e, "LSLP"));
    s.pool.withdraw(&friend, &shares, &0, &0);
}

// ------------------------------------------------------------------ property tests

proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]

    /// Invariants over random deposits and swaps:
    /// 1. k = reserve_a·reserve_b never decreases on a swap.
    /// 2. Value of one LP share (√k / supply) never decreases.
    /// 3. Recorded reserves always equal the pool's actual balances.
    /// 4. Nobody gets something for nothing: a swap round trip never returns more than was put in.
    #[test]
    fn invariants_hold(
        ra in 10_000i128..1_000_000_000_000,
        rb in 10_000i128..1_000_000_000_000,
        swaps in proptest::collection::vec((any::<bool>(), 1i128..1_000_000_000_000), 1..8),
    ) {
        let s = setup();
        let lp = Address::generate(&s.e);
        let trader = Address::generate(&s.e);
        fund(&s, &lp, ra.max(rb));
        fund(&s, &trader, 10_000_000_000_000);
        prop_assume!(s.pool.try_deposit(&lp, &ra, &rb, &0, &0).is_ok());

        for (a_to_b, amount) in swaps {
            let before = s.pool.info();
            let k_before = before.reserve_a as f64 * before.reserve_b as f64;
            let share_before = k_before.sqrt() / before.total_shares as f64;
            let (t_in, t_out) = if a_to_b { (s.a.clone(), s.b.clone()) } else { (s.b.clone(), s.a.clone()) };
            let out_before = bal(&s, &t_out, &trader);
            let in_before = bal(&s, &t_in, &trader);
            let Ok(Ok(out)) = s.pool.try_swap(&trader, &trader, &t_in, &amount, &0) else { continue };

            let after = s.pool.info();
            let k_after = after.reserve_a as f64 * after.reserve_b as f64;
            prop_assert!(k_after >= k_before * (1.0 - 1e-12));
            prop_assert!(k_after.sqrt() / after.total_shares as f64 >= share_before * (1.0 - 1e-12));
            let (ba, bb) = (bal(&s, &s.a, &s.pool.address), bal(&s, &s.b, &s.pool.address));
            prop_assert_eq!((ba, bb), (after.reserve_a, after.reserve_b));
            prop_assert_eq!(bal(&s, &t_out, &trader) - out_before, out);
            prop_assert_eq!(in_before - bal(&s, &t_in, &trader), amount);

            // Immediate reverse swap must not return more than `amount`.
            if let Ok(Ok(back)) = s.pool.try_swap(&trader, &trader, &t_out, &out, &0) {
                prop_assert!(back < amount);
            }
        }
    }

    /// Deposit then immediately withdraw never returns more than was deposited.
    #[test]
    fn deposit_withdraw_no_free_money(
        ra in 10_000i128..1_000_000_000_000,
        rb in 10_000i128..1_000_000_000_000,
        da in 1i128..1_000_000_000_000,
        db in 1i128..1_000_000_000_000,
    ) {
        let s = setup();
        let lp = Address::generate(&s.e);
        let user = Address::generate(&s.e);
        fund(&s, &lp, ra.max(rb));
        fund(&s, &user, da.max(db));
        prop_assume!(s.pool.try_deposit(&lp, &ra, &rb, &0, &0).is_ok());
        let Ok(Ok((a, b, shares))) = s.pool.try_deposit(&user, &da, &db, &0, &0) else { return Ok(()) };
        let (wa, wb) = s.pool.withdraw(&user, &shares, &0, &0);
        prop_assert!(wa <= a && wb <= b);
    }
}

#[test]
fn deposit_raw_keeps_the_ratio_and_refunds_the_rest() {
    let s = setup();
    let lp = Address::generate(&s.e);
    let user = Address::generate(&s.e);
    fund(&s, &lp, 10_000_000);
    fund(&s, &user, 10_000_000);
    s.pool.deposit(&lp, &1_000_000, &2_000_000, &0, &0);
    assert_eq!(s.pool.tokens(), (s.a.clone(), s.b.clone()));

    // Router style: the user sends more B than the ratio needs, then the pool settles.
    TokenClient::new(&s.e, &s.a).transfer(&user, &s.pool.address, &100_000);
    TokenClient::new(&s.e, &s.b).transfer(&user, &s.pool.address, &300_000);
    let supply = s.pool.total_supply();
    let (a, b, shares) = s.pool.deposit_raw(&user, &100_000, &200_000);
    assert_eq!((a, b), (100_000, 200_000));
    assert_eq!(shares, supply / 10);
    assert_eq!(s.pool.balance(&user), shares);
    // 100,000 B came back; the pool holds exactly its reserves.
    assert_eq!(bal(&s, &s.b, &user), 10_000_000 - 200_000);
    let info = s.pool.info();
    assert_eq!((info.reserve_a, info.reserve_b), (1_100_000, 2_200_000));
    assert_eq!(bal(&s, &s.a, &s.pool.address), 1_100_000);
    assert_eq!(bal(&s, &s.b, &s.pool.address), 2_200_000);
}

#[test]
fn deposit_raw_checks_minimums_and_needs_both_tokens() {
    let s = setup();
    let lp = Address::generate(&s.e);
    fund(&s, &lp, 10_000_000);
    s.pool.deposit(&lp, &1_000_000, &1_000_000, &0, &0);
    TokenClient::new(&s.e, &s.a).transfer(&lp, &s.pool.address, &100_000);
    // Only A was sent: nothing to pair it with.
    assert_eq!(s.pool.try_deposit_raw(&lp, &0, &0), Err(Ok(PoolError::InvalidAmount.into())));
    TokenClient::new(&s.e, &s.b).transfer(&lp, &s.pool.address, &50_000);
    // The ratio allows only 50,000 A, below the 60,000 minimum.
    assert_eq!(s.pool.try_deposit_raw(&lp, &60_000, &0), Err(Ok(PoolError::SlippageA.into())));
    assert_eq!(s.pool.try_deposit_raw(&s.pool.address, &0, &0), Err(Ok(PoolError::InvalidRecipient.into())));
}
