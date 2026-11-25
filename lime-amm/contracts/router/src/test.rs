#![cfg(test)]
extern crate std;

use super::*;
use soroban_sdk::{
    testutils::{Address as _, IssuerFlags, Ledger},
    token::StellarAssetClient,
    vec, Address, Env,
};

mod pool {
    soroban_sdk::contractimport!(file = "../../target/wasm32v1-none/release/lime_amm_pool.wasm");
}
mod fx {
    soroban_sdk::contractimport!(file = "../../target/wasm32v1-none/release/lime_amm_fx_pool.wasm");
}
mod factory {
    soroban_sdk::contractimport!(file = "../../target/wasm32v1-none/release/lime_amm_factory.wasm");
}

const DEADLINE: u64 = 10_000;
const BIG: i128 = 1_000_000_000_000;

struct Setup {
    e: Env,
    router: LimeSwapRouterClient<'static>,
    factory: factory::Client<'static>,
    lp: Address,
    trader: Address,
    x: Address,
    y: Address,
    z: Address,
}

fn setup() -> Setup {
    let e = Env::default();
    e.mock_all_auths();
    e.cost_estimate().budget().reset_unlimited();
    e.ledger().set_timestamp(1_000);
    let admin = Address::generate(&e);
    let wasm = e.deployer().upload_contract_wasm(pool::WASM);
    let factory_id = e.register(factory::WASM, (&admin, wasm));
    let router_id = e.register(LimeSwapRouter, (&factory_id,));
    let lp = Address::generate(&e);
    let trader = Address::generate(&e);
    let mut tokens = std::vec::Vec::new();
    for _ in 0..3 {
        let sac = e.register_stellar_asset_contract_v2(admin.clone());
        sac.issuer().set_flag(IssuerFlags::ClawbackEnabledFlag);
        let t = sac.address();
        StellarAssetClient::new(&e, &t).mint(&lp, &BIG);
        StellarAssetClient::new(&e, &t).mint(&trader, &BIG);
        tokens.push(t);
    }
    Setup {
        router: LimeSwapRouterClient::new(&e, &router_id),
        factory: factory::Client::new(&e, &factory_id),
        lp,
        trader,
        x: tokens[0].clone(),
        y: tokens[1].clone(),
        z: tokens[2].clone(),
        e,
    }
}

fn bal(s: &Setup, t: &Address, who: &Address) -> i128 {
    TokenClient::new(&s.e, t).balance(who)
}

fn add(s: &Setup, a: &Address, b: &Address, fee: u32, amount_a: i128, amount_b: i128) {
    s.router.add_liquidity(&s.lp, a, b, &fee, &amount_a, &amount_b, &0, &0, &DEADLINE);
}

#[test]
fn add_liquidity_creates_pool_and_respects_caller_order() {
    let s = setup();
    // Pass tokens "backwards" relative to address order; amounts must follow the caller's order.
    let (hi, lo) = if s.x > s.y { (s.x.clone(), s.y.clone()) } else { (s.y.clone(), s.x.clone()) };
    let (a, b, shares) = s.router.add_liquidity(&s.lp, &hi, &lo, &30, &100_000_000, &300_000_000, &0, &0, &DEADLINE);
    assert_eq!((a, b), (100_000_000, 300_000_000));
    assert!(shares > 0);
    let pool = s.factory.get_pool(&hi, &lo, &30).unwrap();
    assert_eq!(bal(&s, &hi, &pool), 100_000_000);
    assert_eq!(bal(&s, &lo, &pool), 300_000_000);

    let (ra, rb) = s.router.remove_liquidity(&s.lp, &hi, &lo, &30, &shares, &0, &0, &DEADLINE);
    assert!(ra > 99_000_000 && rb > 299_000_000);
}

#[test]
fn multi_hop_swap_matches_quote() {
    let s = setup();
    add(&s, &s.x, &s.y, 30, 1_000_000_000, 2_000_000_000);
    add(&s, &s.y, &s.z, 5, 2_000_000_000, 2_000_000_000);
    let path = vec![&s.e, s.x.clone(), s.y.clone(), s.z.clone()];
    let fees = vec![&s.e, 30u32, 5u32];
    let quote = s.router.quote(&10_000_000, &path, &fees);
    let z_before = bal(&s, &s.z, &s.trader);
    let amounts = s.router.swap_exact_in(&s.trader, &s.trader, &10_000_000, &quote.get(2).unwrap(), &path, &fees, &DEADLINE);
    assert_eq!(amounts, quote);
    assert_eq!(bal(&s, &s.z, &s.trader) - z_before, quote.get(2).unwrap());
    // Router never holds funds.
    for t in [&s.x, &s.y, &s.z] {
        assert_eq!(bal(&s, t, &s.router.address), 0);
    }
}

#[test]
fn atomic_arbitrage_cycle_between_fee_tiers() {
    let s = setup();
    // Same pair, two pools with different prices: X is cheap in the 0.3% pool, dear in the 1% pool.
    add(&s, &s.x, &s.y, 30, 1_000_000_000, 1_000_000_000);
    add(&s, &s.x, &s.y, 100, 1_000_000_000, 1_200_000_000);
    let path = vec![&s.e, s.y.clone(), s.x.clone(), s.y.clone()];
    let fees = vec![&s.e, 30u32, 100u32];
    let amount = 20_000_000;
    let quote = s.router.quote(&amount, &path, &fees);
    let profit = quote.get(2).unwrap() - amount;
    assert!(profit > 0, "cycle should be profitable: {profit}");
    let y_before = bal(&s, &s.y, &s.trader);
    // min_out = amount_in → the whole cycle reverts unless it makes money.
    s.router.swap_exact_in(&s.trader, &s.trader, &amount, &amount, &path, &fees, &DEADLINE);
    assert_eq!(bal(&s, &s.y, &s.trader) - y_before, profit);

    // Reverse direction loses money → min_out guard reverts it atomically.
    let back = vec![&s.e, s.y.clone(), s.x.clone(), s.y.clone()];
    let back_fees = vec![&s.e, 100u32, 30u32];
    let r = s.router.try_swap_exact_in(&s.trader, &s.trader, &amount, &amount, &back, &back_fees, &DEADLINE);
    assert_eq!(r, Err(Ok(RouterError::InsufficientOutput.into())));
}

#[test]
fn deadline_and_path_validation() {
    let s = setup();
    add(&s, &s.x, &s.y, 30, 1_000_000_000, 1_000_000_000);
    let path = vec![&s.e, s.x.clone(), s.y.clone()];
    let fees = vec![&s.e, 30u32];
    s.e.ledger().set_timestamp(DEADLINE + 1);
    assert_eq!(
        s.router.try_swap_exact_in(&s.trader, &s.trader, &1_000, &0, &path, &fees, &DEADLINE),
        Err(Ok(RouterError::Expired.into()))
    );
    assert_eq!(
        s.router.try_quote(&1_000, &path, &vec![&s.e, 30u32, 30u32]),
        Err(Ok(RouterError::InvalidPath.into()))
    );
    assert_eq!(
        s.router.try_quote(&1_000, &vec![&s.e, s.x.clone(), s.z.clone()], &fees),
        Err(Ok(RouterError::PoolNotFound.into()))
    );
}

// ---------------------------------------------------------------- v2: LimeFX hops, fixed deposits

use lime_amm_mock_oracle::{Asset as OAsset, MockOracle, MockOracleClient};
use soroban_sdk::symbol_short;

const EUR_USD: i128 = 110_000_000_000_000; // 1.10, 14 decimals

/// LimeFX pool for (x, y) sorted, the first one priced as EUR and the second as USD (the oracle
/// base). Seeded balanced at 1.10: 10,000 + 11,000 units.
fn fx_pool(s: &Setup) -> (fx::Client<'static>, Address, Address) {
    let (eur, usd) = if s.x < s.y { (s.x.clone(), s.y.clone()) } else { (s.y.clone(), s.x.clone()) };
    let admin = Address::generate(&s.e);
    let oid = s.e.register(MockOracle, (&admin, OAsset::Other(symbol_short!("USD")), 14u32, 300u32));
    let oracle = MockOracleClient::new(&s.e, &oid);
    let now = s.e.ledger().timestamp();
    for i in (0..7u64).rev() {
        oracle.set_price(&OAsset::Other(symbol_short!("EUR")), &EUR_USD, &(now - i * 300));
    }
    let id = s.e.register(
        fx::WASM,
        (
            &admin,
            &eur,
            &usd,
            &oid,
            fx::Asset::Other(symbol_short!("EUR")),
            fx::Asset::Other(symbol_short!("USD")),
            5u32,
            100u32,
            EUR_USD / 2,
            EUR_USD * 2,
        ),
    );
    let pool = fx::Client::new(&s.e, &id);
    pool.deposit(&s.lp, &100_000_000_000, &110_000_000_000, &0, &0);
    (pool, eur, usd)
}

#[test]
fn route_through_limefx_then_limeswap_matches_quote() {
    let s = setup();
    s.e.ledger().set_timestamp(10_000);
    let (fxp, eur, usd) = fx_pool(&s);
    add(&s, &usd, &s.z, 30, 500_000_000_000, 500_000_000_000);
    let tokens = vec![&s.e, eur.clone(), usd.clone(), s.z.clone()];
    let hops = vec![&s.e, Hop::Fx(fxp.address.clone()), Hop::Pool(30)];
    let quote = s.router.quote_route(&1_000_000_000, &tokens, &hops);
    let before = bal(&s, &s.z, &s.trader);
    let amounts = s.router.swap_route(&s.trader, &s.trader, &1_000_000_000, &quote.get(2).unwrap(), &tokens, &hops, &20_000);
    assert_eq!(amounts, quote);
    assert_eq!(bal(&s, &s.z, &s.trader) - before, quote.get(2).unwrap());
    // ~1.10 USD per EUR minus small fees and impact.
    assert!(quote.get(1).unwrap() > 1_098_000_000);
    for t in [&eur, &usd, &s.z] {
        assert_eq!(bal(&s, t, &s.router.address), 0);
    }
}

#[test]
fn arbitrage_cycle_between_limefx_and_a_drifted_pool() {
    let s = setup();
    s.e.ledger().set_timestamp(10_000);
    let (fxp, eur, usd) = fx_pool(&s);
    // A plain pool that still prices EUR at 1.00 USD: EUR is cheap there.
    add(&s, &eur, &usd, 30, 100_000_000_000, 100_000_000_000);
    let tokens = vec![&s.e, usd.clone(), eur.clone(), usd.clone()];
    let hops = vec![&s.e, Hop::Pool(30), Hop::Fx(fxp.address.clone())];
    let amount = 1_000_000_000;
    let quote = s.router.quote_route(&amount, &tokens, &hops);
    let profit = quote.get(2).unwrap() - amount;
    assert!(profit > 0, "cycle should be profitable: {profit}");
    let before = bal(&s, &usd, &s.trader);
    s.router.swap_route(&s.trader, &s.trader, &amount, &amount, &tokens, &hops, &20_000);
    assert_eq!(bal(&s, &usd, &s.trader) - before, profit);
    // The other direction loses money: min_out = amount_in reverts the whole cycle.
    let back = vec![&s.e, Hop::Fx(fxp.address.clone()), Hop::Pool(30)];
    assert_eq!(
        s.router.try_swap_route(&s.trader, &s.trader, &amount, &amount, &tokens, &back, &20_000),
        Err(Ok(RouterError::InsufficientOutput.into()))
    );
}

#[test]
fn fx_hop_must_trade_the_hop_tokens() {
    let s = setup();
    s.e.ledger().set_timestamp(10_000);
    let (fxp, eur, _usd) = fx_pool(&s);
    let tokens = vec![&s.e, eur.clone(), s.z.clone()];
    let hops = vec![&s.e, Hop::Fx(fxp.address.clone())];
    assert_eq!(s.router.try_quote_route(&1_000, &tokens, &hops), Err(Ok(RouterError::WrongPool.into())));
    assert_eq!(
        s.router.try_quote_route(&1_000, &tokens, &vec![&s.e]),
        Err(Ok(RouterError::InvalidPath.into()))
    );
}

#[test]
fn add_liquidity_signs_fixed_amounts_and_refunds_the_excess() {
    let s = setup();
    add(&s, &s.x, &s.y, 30, 1_000_000_000, 2_000_000_000);
    let (x0, y0) = (bal(&s, &s.x, &s.trader), bal(&s, &s.y, &s.trader));
    // Offer 2× too much Y: only the ratio amount stays in the pool.
    let (a, b, shares) = s.router.add_liquidity(&s.trader, &s.x, &s.y, &30, &100_000_000, &400_000_000, &0, &0, &DEADLINE);
    let auths = s.e.auths(); // auths of the last call only: read before any other call
    assert_eq!((a, b), (100_000_000, 200_000_000));
    assert!(shares > 0);
    assert_eq!(x0 - bal(&s, &s.x, &s.trader), 100_000_000);
    assert_eq!(y0 - bal(&s, &s.y, &s.trader), 200_000_000);
    // The signed transfers carry the desired amounts, whatever the reserves are at execution.
    let (_, top) = auths.iter().find(|(who, _)| *who == s.trader).unwrap();
    let transfers: std::vec::Vec<i128> = top
        .sub_invocations
        .iter()
        .filter_map(|inv| match &inv.function {
            soroban_sdk::testutils::AuthorizedFunction::Contract((_, f, args)) if *f == soroban_sdk::Symbol::new(&s.e, "transfer") => {
                Some(soroban_sdk::TryFromVal::try_from_val(&s.e, &args.get(2).unwrap()).unwrap())
            }
            _ => None,
        })
        .collect();
    assert_eq!(transfers, std::vec![100_000_000, 400_000_000]);
}

#[test]
fn add_liquidity_to_limefx() {
    let s = setup();
    s.e.ledger().set_timestamp(10_000);
    let (fxp, eur, usd) = fx_pool(&s);
    let (e0, u0) = (bal(&s, &eur, &s.trader), bal(&s, &usd, &s.trader));
    let (a, b, shares) = s.router.add_liquidity_to(&s.trader, &fxp.address, &eur, &usd, &1_000_000_000, &2_000_000_000, &0, &0, &20_000);
    assert_eq!((a, b), (1_000_000_000, 1_100_000_000));
    assert_eq!(fxp.balance(&s.trader), shares);
    assert_eq!(e0 - bal(&s, &eur, &s.trader), a);
    assert_eq!(u0 - bal(&s, &usd, &s.trader), b);
}

#[test]
fn add_liquidity_to_checks_the_tokens_it_signs_away() {
    let s = setup();
    s.e.ledger().set_timestamp(10_000);
    let (fxp, eur, usd) = fx_pool(&s);
    assert_eq!(
        s.router.try_add_liquidity_to(&s.trader, &fxp.address, &usd, &eur, &1_000, &1_000, &0, &0, &20_000),
        Err(Ok(RouterError::WrongPool.into()))
    );
}

// Review finding (Medium): after an unsynced issuer clawback, the user's own input must not
// fill the pool's shortfall.
#[test]
fn deposit_after_clawback_costs_the_user_nothing_extra() {
    let s = setup();
    add(&s, &s.x, &s.y, 30, 1_000_000_000, 1_000_000_000);
    let pool = s.factory.get_pool(&s.x, &s.y, &30).unwrap();
    StellarAssetClient::new(&s.e, &s.x).clawback(&pool, &50_000_000);
    let (x0, y0) = (bal(&s, &s.x, &s.trader), bal(&s, &s.y, &s.trader));
    let (a, b, _) = s.router.add_liquidity(&s.trader, &s.x, &s.y, &30, &100_000_000, &100_000_000, &0, &0, &DEADLINE);
    // Ratio after the clawback is 950:1000, so 100 X pairs with ~105 Y → Y is capped at 100.
    assert_eq!(x0 - bal(&s, &s.x, &s.trader), a);
    assert_eq!(y0 - bal(&s, &s.y, &s.trader), b);
    assert!(a >= 94_000_000 && b == 100_000_000, "a={a} b={b}");
    // Swaps keep working without anyone calling `sync`.
    let path = vec![&s.e, s.x.clone(), s.y.clone()];
    s.router.swap_exact_in(&s.trader, &s.trader, &1_000_000, &1, &path, &vec![&s.e, 30u32], &DEADLINE);
}

#[test]
fn fx_route_after_clawback_pays_the_quote() {
    let s = setup();
    s.e.ledger().set_timestamp(10_000);
    let (fxp, eur, usd) = fx_pool(&s);
    StellarAssetClient::new(&s.e, &eur).clawback(&fxp.address, &500_000_000); // 0.5% of the EUR side
    let tokens = vec![&s.e, eur.clone(), usd.clone()];
    let hops = vec![&s.e, Hop::Fx(fxp.address.clone())];
    let quote = s.router.quote_route(&10_000_000_000, &tokens, &hops).get(1).unwrap();
    // Quote on the unsynced pool is what the dApp would show; swap_route reconciles first.
    let before = bal(&s, &usd, &s.trader);
    s.router.swap_route(&s.trader, &s.trader, &10_000_000_000, &(quote * 99 / 100), &tokens, &hops, &20_000);
    assert!(bal(&s, &usd, &s.trader) - before >= quote * 99 / 100);
}
