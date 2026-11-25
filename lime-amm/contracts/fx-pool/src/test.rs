#![cfg(test)]
extern crate std;

use super::*;
use lime_amm_mock_oracle::{Asset as OAsset, MockOracle, MockOracleClient};
use proptest::prelude::*;
use soroban_sdk::{
    contract, contractimpl, symbol_short,
    testutils::{Address as _, Ledger},
    token::StellarAssetClient,
    Address, Env,
};

const T0: u64 = 1_800_000_000;
const ONE: i128 = PRICE_SCALE; // oracle decimals = 14, same scale
const EUR_USD: i128 = 110_000_000_000_000; // 1.10
const UNIT: i128 = 10_000_000; // 7-decimal token unit
/// Wide default band (0.01 – 100) so only band-specific tests hit it.
const BAND_MIN: i128 = PRICE_SCALE / 100;
const BAND_MAX: i128 = PRICE_SCALE * 100;

struct Setup {
    e: Env,
    admin: Address,
    a: Address,
    b: Address,
    oracle: MockOracleClient<'static>,
    pool: LimeFxPoolClient<'static>,
}

fn eur() -> OAsset {
    OAsset::Other(symbol_short!("EUR"))
}

fn new_token(e: &Env, admin: &Address) -> Address {
    e.register_stellar_asset_contract_v2(admin.clone()).address()
}

fn sorted_tokens(e: &Env, admin: &Address) -> (Address, Address) {
    let (a, b) = (new_token(e, admin), new_token(e, admin));
    if a < b { (a, b) } else { (b, a) }
}

/// Pool A = "EURC" (oracle EUR), B = "USDC" (oracle base USD). EUR history: 7 records at
/// `price`, 300 s apart, newest at T0.
fn setup_with(price: i128, base_fee: u32, amp: u32) -> Setup {
    let e = Env::default();
    e.mock_all_auths();
    e.cost_estimate().budget().reset_unlimited();
    e.ledger().set_timestamp(T0);
    let admin = Address::generate(&e);
    let (a, b) = sorted_tokens(&e, &admin);
    let oid = e.register(MockOracle, (&admin, OAsset::Other(symbol_short!("USD")), 14u32, 300u32));
    let oracle = MockOracleClient::new(&e, &oid);
    for i in (0..7u64).rev() {
        oracle.set_price(&eur(), &price, &(T0 - i * 300));
    }
    let id = e.register(
        LimeFxPool,
        (
            &admin,
            &a,
            &b,
            &oid,
            Asset::Other(symbol_short!("EUR")),
            Asset::Other(symbol_short!("USD")),
            base_fee,
            amp,
            BAND_MIN,
            BAND_MAX,
        ),
    );
    let pool = LimeFxPoolClient::new(&e, &id);
    Setup { e, admin, a, b, oracle, pool }
}

fn setup() -> Setup {
    setup_with(EUR_USD, 5, 100)
}

/// v3: lift the outflow cap (100% per window) for tests about the curve itself.
fn uncap(s: &Setup) {
    s.pool.set_outflow_cap(&s.admin, &OutflowCap { cap_bps: 10_000, window: DEFAULT_CAP_WINDOW });
}

fn fund(s: &Setup, who: &Address, amount: i128) {
    StellarAssetClient::new(&s.e, &s.a).mint(who, &amount);
    StellarAssetClient::new(&s.e, &s.b).mint(who, &amount);
}

fn bal(s: &Setup, token: &Address, who: &Address) -> i128 {
    TokenClient::new(&s.e, token).balance(who)
}

/// LP with a pool balanced at the oracle price: 1M EURC + 1.1M USDC.
fn seed_balanced(s: &Setup) -> Address {
    let lp = Address::generate(&s.e);
    fund(s, &lp, 10_000_000 * UNIT);
    s.pool.deposit(&lp, &(1_000_000 * UNIT), &(1_100_000 * UNIT), &0, &0);
    lp
}

/// Next oracle round: advance time by one resolution and publish `price` for EUR.
fn push_price(s: &Setup, price: i128) {
    let now = s.e.ledger().timestamp() + 300;
    s.e.ledger().set_timestamp(now);
    s.oracle.set_price(&eur(), &price, &now);
}

fn set(s: &Setup, f: impl FnOnce(&mut FxParams)) {
    let mut p = s.pool.info().params;
    f(&mut p);
    s.pool.set_params(&s.admin, &p);
}

fn try_set(s: &Setup, f: impl FnOnce(&mut FxParams)) -> Result<(), FxPoolError> {
    let mut p = s.pool.info().params;
    f(&mut p);
    match s.pool.try_set_params(&s.admin, &p) {
        Ok(_) => Ok(()),
        Err(Ok(e)) => Err(FxPoolError::try_from(e).unwrap()),
        Err(Err(e)) => panic!("{:?}", e),
    }
}

fn err(code: FxPoolError) -> soroban_sdk::Error {
    code.into()
}

fn quote_err(s: &Setup) -> Option<soroban_sdk::Error> {
    match s.pool.try_quote(&s.a, &UNIT) {
        Ok(_) => None,
        Err(Ok(e)) => Some(e),
        Err(Err(e)) => panic!("{:?}", e),
    }
}

// ---------------------------------------------------------------- pricing

#[test]
fn balanced_pool_swaps_at_oracle_price_minus_fee() {
    let s = setup();
    seed_balanced(&s);
    let q = s.pool.quote(&s.a, &(1_000 * UNIT));
    assert_eq!(q.fee_bps, 5);
    assert_eq!(q.oracle_price, EUR_USD);
    // 1000 EUR at 1.10 minus 0.05% fee = 1099.45 USD; slippage with amp=100 is ~1e-5.
    let ideal = 1_099_450 * UNIT / 1_000;
    assert!(q.amount_out <= ideal, "{} > {}", q.amount_out, ideal);
    assert!(q.amount_out * 100_000 >= ideal * 99_998, "{} too far below {}", q.amount_out, ideal);

    let trader = Address::generate(&s.e);
    fund(&s, &trader, 10_000 * UNIT);
    let out = s.pool.swap(&trader, &trader, &s.a, &(1_000 * UNIT), &q.amount_out);
    assert_eq!(out, q.amount_out);
    assert_eq!(bal(&s, &s.b, &trader), 10_000 * UNIT + out);
    let info = s.pool.info();
    assert_eq!((info.reserve_a, info.reserve_b), (1_001_000 * UNIT, 1_100_000 * UNIT - out));

    // The other direction: 1100 USD -> ≈ 999.5 EUR. The pool now holds extra EUR, so this
    // direction gets a hair *better* than oracle minus fee (the rebalancing incentive).
    let back = s.pool.quote(&s.b, &(1_100 * UNIT)).amount_out;
    let ideal_back = 9_995 * UNIT / 10;
    assert!((back - ideal_back).abs() * 10_000 < ideal_back, "back = {}", back);
}

#[test]
fn amp_zero_is_plain_constant_product() {
    let s = setup_with(EUR_USD, 30, 0);
    uncap(&s);
    let lp = Address::generate(&s.e);
    fund(&s, &lp, 10_000_000 * UNIT);
    s.pool.deposit(&lp, &(300_000 * UNIT), &(700_000 * UNIT), &0, &0);
    for amount in [1i128, 12_345, 50_000 * UNIT, 2_000_000 * UNIT] {
        let net = amount * 9_970 / 10_000;
        let (ra, rb) = (300_000 * UNIT, 700_000 * UNIT);
        assert_eq!(s.pool.quote(&s.a, &amount).amount_out, rb * net / (ra + net));
        assert_eq!(s.pool.quote(&s.b, &amount).amount_out, ra * net / (rb + net));
    }
}

#[test]
fn oracle_move_recentres_price_without_arbitrage() {
    let new_price = 112_000_000_000_000; // EUR/USD 1.10 -> 1.12 (+1.8%)
    let probe = 10 * UNIT;
    let gross = |out: i128| out as f64 / (probe as f64 * (1.0 - 5e-4));
    // Same reserves and oracle move in an fx pool (amp 100) and a plain cp pool (amp 0).
    let marginal = |amp: u32| {
        let s = setup_with(EUR_USD, 5, amp);
        seed_balanced(&s);
        set(&s, |p| p.vol_mult = 0); // isolate the curve from the dynamic fee
        push_price(&s, new_price);
        gross(s.pool.quote(&s.a, &probe).amount_out)
    };
    // fx pool: ≈ 1.12 even though nobody traded.
    let fx_px = marginal(100);
    assert!((fx_px / 1.12 - 1.0).abs() < 5e-4, "fx pool price {} should track 1.12", fx_px);
    // cp pool: still 1.10, so an arbitrageur would take the 1.8% from LPs.
    let cp_px = marginal(0);
    assert!((cp_px / 1.10 - 1.0).abs() < 5e-4, "cp price {} stays at 1.10", cp_px);
}

struct Cross {
    e: Env,
    a: Address,
    oracle: MockOracleClient<'static>,
    pool: LimeFxPoolClient<'static>,
}

/// EUR/GBP pool (neither is the oracle base): 3 records each at 1.10 / 1.30 USD.
fn setup_cross() -> Cross {
    let e = Env::default();
    e.mock_all_auths();
    e.cost_estimate().budget().reset_unlimited();
    e.ledger().set_timestamp(T0);
    let admin = Address::generate(&e);
    let (a, b) = sorted_tokens(&e, &admin);
    let oid = e.register(MockOracle, (&admin, OAsset::Other(symbol_short!("USD")), 14u32, 300u32));
    let oracle = MockOracleClient::new(&e, &oid);
    let gbp = OAsset::Other(symbol_short!("GBP"));
    for i in (0..3u64).rev() {
        oracle.set_price(&eur(), &EUR_USD, &(T0 - i * 300));
        oracle.set_price(&gbp, &(130 * ONE / 100), &(T0 - i * 300));
    }
    let id = e.register(
        LimeFxPool,
        (
            &admin,
            &a,
            &b,
            &oid,
            Asset::Other(symbol_short!("EUR")),
            Asset::Other(symbol_short!("GBP")),
            5u32,
            100u32,
            BAND_MIN,
            BAND_MAX,
        ),
    );
    let pool = LimeFxPoolClient::new(&e, &id);
    let lp = Address::generate(&e);
    StellarAssetClient::new(&e, &a).mint(&lp, &(1_000_000 * UNIT));
    StellarAssetClient::new(&e, &b).mint(&lp, &(1_000_000 * UNIT));
    pool.deposit(&lp, &(130_000 * UNIT), &(110_000 * UNIT), &0, &0);
    Cross { e, a, oracle, pool }
}

#[test]
fn cross_rate_of_two_non_base_assets() {
    let c = setup_cross();
    let q = c.pool.quote(&c.a, &UNIT);
    assert_eq!(q.oracle_price, EUR_USD * PRICE_SCALE / (130 * ONE / 100)); // 1.10/1.30
    assert_eq!(q.fee_bps, 5);
}

#[test]
fn non_base_prices_must_be_within_one_resolution() {
    let c = setup_cross();
    // EUR updates, GBP's feed stalls: still fine 300 s apart...
    c.e.ledger().set_timestamp(T0 + 300);
    c.oracle.set_price(&eur(), &EUR_USD, &(T0 + 300));
    assert!(c.pool.try_quote(&c.a, &UNIT).is_ok());
    // ...but 301 s apart is skew (GBP itself is still younger than max_age = 360).
    c.e.ledger().set_timestamp(T0 + 301);
    c.oracle.set_price(&eur(), &EUR_USD, &(T0 + 301));
    assert_eq!(c.pool.try_quote(&c.a, &UNIT), Err(Ok(err(FxPoolError::PriceSkew))));
}

// ---------------------------------------------------------------- oracle safety

#[test]
fn stale_price_reverts_but_withdraw_works() {
    let s = setup();
    let lp = seed_balanced(&s);
    let max_age = s.pool.info().params.max_age;
    assert_eq!(max_age, 360); // resolution + 60 s
    s.e.ledger().set_timestamp(T0 + max_age);
    assert!(s.pool.try_quote(&s.a, &UNIT).is_ok());
    s.e.ledger().set_timestamp(T0 + max_age + 1);
    assert_eq!(quote_err(&s), Some(err(FxPoolError::StalePrice)));
    let trader = Address::generate(&s.e);
    fund(&s, &trader, 10 * UNIT);
    assert_eq!(s.pool.try_swap(&trader, &trader, &s.a, &UNIT, &0), Err(Ok(err(FxPoolError::StalePrice))));
    let shares = s.pool.balance(&lp);
    s.pool.withdraw(&lp, &shares, &0, &0);
}

#[test]
fn future_timestamp_reverts() {
    let s = setup();
    seed_balanced(&s);
    s.oracle.set_price(&eur(), &EUR_USD, &(T0 + MAX_FUTURE_SKEW));
    assert!(s.pool.try_quote(&s.a, &UNIT).is_ok());
    s.oracle.set_price(&eur(), &EUR_USD, &(T0 + MAX_FUTURE_SKEW + 1));
    assert_eq!(quote_err(&s), Some(err(FxPoolError::FutureTimestamp)));
}

#[test]
fn unstable_price_trips_circuit_breaker() {
    let s = setup();
    let lp = seed_balanced(&s);
    // +5% in one round: 5% away from the mean of the 6 previous records.
    push_price(&s, EUR_USD * 105 / 100);
    assert_eq!(quote_err(&s), Some(err(FxPoolError::PriceUnstable)));
    // A wider breaker lets it through (with the fee at its cap).
    set(&s, |p| p.max_dev_bps = 1_000);
    assert_eq!(s.pool.quote(&s.a, &UNIT).fee_bps, 100);
    set(&s, |p| p.max_dev_bps = 200);
    // Once the 6 previous records are all at the new level, trading resumes at the base fee.
    for _ in 0..6 {
        push_price(&s, EUR_USD * 105 / 100);
    }
    assert_eq!(s.pool.quote(&s.a, &UNIT).fee_bps, 5);
    s.pool.withdraw(&lp, &1_000, &0, &0);
}

#[test]
fn breaker_compares_against_prior_mean() {
    // max_dev 200 bps means 200 bps: the latest record is not part of the mean, so a 2.1%
    // jump trips (an inclusive mean of 7 would see only 1.8%) and a 1.9% jump does not.
    let s = setup();
    seed_balanced(&s);
    push_price(&s, EUR_USD * 1_021 / 1_000);
    assert_eq!(quote_err(&s), Some(err(FxPoolError::PriceUnstable)));

    let s = setup();
    seed_balanced(&s);
    push_price(&s, EUR_USD * 1_019 / 1_000);
    assert_eq!(s.pool.quote(&s.a, &UNIT).fee_bps, 100); // allowed, fee at the cap
}

#[test]
fn hard_price_band() {
    let s = setup();
    seed_balanced(&s);
    // Band 1.00 – 1.12 for EUR/USD; widen the breaker so only the band matters.
    set(&s, |p| {
        p.min_price = PRICE_SCALE;
        p.max_price = PRICE_SCALE * 112 / 100;
        p.max_dev_bps = 5_000;
    });
    assert!(s.pool.try_quote(&s.a, &UNIT).is_ok());
    push_price(&s, PRICE_SCALE * 112 / 100); // exactly at the edge: allowed
    assert!(s.pool.try_quote(&s.a, &UNIT).is_ok());
    push_price(&s, PRICE_SCALE * 112 / 100 + 1);
    assert_eq!(quote_err(&s), Some(err(FxPoolError::PriceOutOfBand)));
    let trader = Address::generate(&s.e);
    fund(&s, &trader, 10 * UNIT);
    assert_eq!(s.pool.try_swap(&trader, &trader, &s.b, &UNIT, &0), Err(Ok(err(FxPoolError::PriceOutOfBand))));
    push_price(&s, PRICE_SCALE - 1);
    assert_eq!(quote_err(&s), Some(err(FxPoolError::PriceOutOfBand)));
    // A slow walk does not get around it either: 20 small steps to 0.80, all out of band.
    for i in 1..=20 {
        push_price(&s, PRICE_SCALE - i * PRICE_SCALE / 100);
        assert_eq!(quote_err(&s), Some(err(FxPoolError::PriceOutOfBand)));
    }
    // Band must be positive and ordered.
    assert_eq!(try_set(&s, |p| p.min_price = 0), Err(FxPoolError::InvalidParams));
    assert_eq!(try_set(&s, |p| p.min_price = p.max_price), Err(FxPoolError::InvalidParams));
}

#[test]
fn missing_price_reverts() {
    let s = setup();
    seed_balanced(&s);
    // Point asset A at a symbol the oracle doesn't quote: rebuild a pool with JPY.
    let id = s.e.register(
        LimeFxPool,
        (
            &s.admin,
            &s.a,
            &s.b,
            &s.oracle.address,
            Asset::Other(symbol_short!("JPY")),
            Asset::Other(symbol_short!("USD")),
            5u32,
            100u32,
            BAND_MIN,
            BAND_MAX,
        ),
    );
    let pool = LimeFxPoolClient::new(&s.e, &id);
    let lp = Address::generate(&s.e);
    fund(&s, &lp, 1_000 * UNIT);
    pool.deposit(&lp, &(100 * UNIT), &(100 * UNIT), &0, &0); // deposits never need the oracle
    assert_eq!(pool.try_quote(&s.a, &UNIT), Err(Ok(err(FxPoolError::PriceMissing))));
}

#[test]
fn dynamic_fee_rises_with_volatility() {
    let s = setup();
    seed_balanced(&s);
    assert_eq!(s.pool.quote(&s.a, &UNIT).fee_bps, 5);
    // +0.2% move vs the mean of the 6 previous records (all 1.10): dev = 20 bps exactly.
    let spot = EUR_USD * 1_002 / 1_000;
    push_price(&s, spot);
    let q = s.pool.quote(&s.a, &UNIT);
    assert_eq!(q.fee_bps, 5 + 2 * 20);
    // Bigger multiplier hits the cap.
    set(&s, |p| p.vol_mult = 10);
    assert_eq!(s.pool.quote(&s.a, &UNIT).fee_bps, 100);
    // Calm again: fee decays back to base once the previous records are at the new level.
    for _ in 0..6 {
        push_price(&s, spot);
    }
    assert_eq!(s.pool.quote(&s.a, &UNIT).fee_bps, 5);
}

#[test]
fn fee_rises_with_price_age() {
    let s = setup_with(EUR_USD, 10, 100);
    seed_balanced(&s);
    // fee = base + base·age/resolution (no deviation here), resolution 300, max_age 360.
    for (age, fee) in [(0u64, 10u32), (150, 15), (299, 19), (300, 20), (360, 22)] {
        s.e.ledger().set_timestamp(T0 + age);
        assert_eq!(s.pool.quote(&s.a, &UNIT).fee_bps, fee, "age {}", age);
    }
    s.e.ledger().set_timestamp(T0 + 361);
    assert_eq!(quote_err(&s), Some(err(FxPoolError::StalePrice)));
}

/// A SEP-40 oracle whose `decimals()` can change underneath the pool.
#[contract]
struct ShiftyOracle;

#[contractimpl]
impl ShiftyOracle {
    pub fn base(e: Env) -> Asset {
        Asset::Other(Symbol::new(&e, "USD"))
    }
    pub fn decimals(e: Env) -> u32 {
        e.storage().instance().get(&symbol_short!("dec")).unwrap_or(14)
    }
    pub fn resolution(_e: Env) -> u32 {
        300
    }
    pub fn set_decimals(e: Env, d: u32) {
        e.storage().instance().set(&symbol_short!("dec"), &d);
    }
    pub fn lastprice(e: Env, _asset: Asset) -> Option<PriceData> {
        Some(PriceData { price: EUR_USD, timestamp: e.ledger().timestamp() })
    }
    pub fn prices(e: Env, _asset: Asset, records: u32) -> Option<Vec<PriceData>> {
        let mut v = Vec::new(&e);
        for i in 0..records as u64 {
            v.push_back(PriceData { price: EUR_USD, timestamp: e.ledger().timestamp() - i * 300 });
        }
        Some(v)
    }
}

#[test]
fn oracle_decimals_change_reverts() {
    let s = setup();
    let oid = s.e.register(ShiftyOracle, ());
    let id = s.e.register(
        LimeFxPool,
        (
            &s.admin,
            &s.a,
            &s.b,
            &oid,
            Asset::Other(symbol_short!("EUR")),
            Asset::Other(symbol_short!("USD")),
            5u32,
            100u32,
            BAND_MIN,
            BAND_MAX,
        ),
    );
    let pool = LimeFxPoolClient::new(&s.e, &id);
    let lp = Address::generate(&s.e);
    fund(&s, &lp, 10_000 * UNIT);
    pool.deposit(&lp, &(1_000 * UNIT), &(1_100 * UNIT), &0, &0);
    assert_eq!(pool.quote(&s.a, &UNIT).oracle_price, EUR_USD);
    ShiftyOracleClient::new(&s.e, &oid).set_decimals(&8);
    assert_eq!(pool.try_quote(&s.a, &UNIT), Err(Ok(err(FxPoolError::OracleChanged))));
}

// ---------------------------------------------------------------- reserves & admin

#[test]
fn cannot_drain_beyond_real_reserves() {
    let s = setup_with(EUR_USD, 5, MAX_AMP);
    uncap(&s);
    seed_balanced(&s);
    let trader = Address::generate(&s.e);
    fund(&s, &trader, 100_000_000 * UNIT);
    // With amp = 10 000 the curve is almost flat: 1.2M EUR "would" buy ~1.32M USD, but the
    // pool only has 1.1M.
    assert_eq!(
        s.pool.try_swap(&trader, &trader, &s.a, &(1_200_000 * UNIT), &0),
        Err(Ok(err(FxPoolError::InsufficientLiquidity)))
    );
    // Just under the real reserve works, and leaves something behind.
    let out = s.pool.swap(&trader, &trader, &s.a, &(990_000 * UNIT), &0);
    let info = s.pool.info();
    assert!(info.reserve_b > 0 && out < 1_100_000 * UNIT);
    assert_eq!(bal(&s, &s.b, &s.pool.address), info.reserve_b);
}

#[test]
fn amp_changes_are_ramped_and_timelocked() {
    let s = setup(); // amp 100
    assert_eq!(try_set(&s, |p| p.amp = 201), Err(FxPoolError::AmpChangeTooLarge));
    assert_eq!(try_set(&s, |p| p.amp = 49), Err(FxPoolError::AmpChangeTooLarge));
    assert_eq!(try_set(&s, |p| p.amp = 0), Err(FxPoolError::AmpChangeTooLarge));
    set(&s, |p| p.amp = 200);
    // Second change inside 24 h: refused; other params still change freely.
    assert_eq!(try_set(&s, |p| p.amp = 150), Err(FxPoolError::AmpChangeTooFast));
    set(&s, |p| p.base_fee_bps = 7);
    s.e.ledger().set_timestamp(T0 + AMP_CHANGE_DELAY - 1);
    assert_eq!(try_set(&s, |p| p.amp = 150), Err(FxPoolError::AmpChangeTooFast));
    s.e.ledger().set_timestamp(T0 + AMP_CHANGE_DELAY);
    set(&s, |p| p.amp = 100);
    assert_eq!(s.pool.info().params.amp, 100);

    // From / to zero only via amp ≤ 10.
    let s = setup_with(EUR_USD, 5, 0);
    assert_eq!(try_set(&s, |p| p.amp = 11), Err(FxPoolError::AmpChangeTooLarge));
    set(&s, |p| p.amp = 10);
    s.e.ledger().set_timestamp(T0 + AMP_CHANGE_DELAY);
    set(&s, |p| p.amp = 0);
}

#[test]
fn pause_admin_and_params() {
    let s = setup();
    let lp = seed_balanced(&s);
    let stranger = Address::generate(&s.e);
    assert_eq!(s.pool.try_pause(&stranger), Err(Ok(err(FxPoolError::Unauthorized))));
    let p = s.pool.info().params;
    assert_eq!(s.pool.try_set_params(&stranger, &p), Err(Ok(err(FxPoolError::Unauthorized))));
    assert_eq!(try_set(&s, |p| p.history = MAX_HISTORY + 1), Err(FxPoolError::InvalidParams));
    assert_eq!(try_set(&s, |p| p.amp = MAX_AMP + 1), Err(FxPoolError::InvalidParams));
    assert_eq!(try_set(&s, |p| p.base_fee_bps = 200), Err(FxPoolError::InvalidFee));

    s.pool.pause(&s.admin);
    let trader = Address::generate(&s.e);
    fund(&s, &trader, 10 * UNIT);
    assert!(s.pool.try_swap(&trader, &trader, &s.a, &UNIT, &0).is_err());
    assert!(s.pool.try_quote(&s.a, &UNIT).is_err()); // quote reverts while paused, like swap
    assert!(s.pool.try_deposit(&trader, &UNIT, &UNIT, &0, &0).is_err());
    let shares = s.pool.balance(&lp);
    s.pool.withdraw(&lp, &shares, &0, &0); // exit always works
    s.pool.unpause(&s.admin);
    assert_eq!(s.pool.version(), VERSION);
    assert_eq!(s.pool.symbol(), String::from_str(&s.e, "LFXLP"));
    assert_eq!(s.pool.decimals(), 7);
}

#[contract]
struct SixDecimals;

#[contractimpl]
impl SixDecimals {
    pub fn decimals(_e: Env) -> u32 {
        6
    }
}

#[test]
fn constructor_validates_inputs() {
    let s = setup();
    let usd = Asset::Other(symbol_short!("USD"));
    let eur_a = Asset::Other(symbol_short!("EUR"));
    let o = s.oracle.address.clone();
    let (a, b) = (s.a.clone(), s.b.clone());
    let reg = |ta: &Address, tb: &Address, aa: &Asset, ab: &Asset, fee: u32, amp: u32, band: (i128, i128)| {
        let e = s.e.clone();
        let args = (&s.admin, ta, tb, &o, aa.clone(), ab.clone(), fee, amp, band.0, band.1);
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
            e.register(LimeFxPool, args);
        }))
        .is_ok()
    };
    let band = (BAND_MIN, BAND_MAX);
    assert!(reg(&a, &b, &eur_a, &usd, 5, 100, band));
    assert!(!reg(&b, &a, &eur_a, &usd, 5, 100, band)); // unsorted
    assert!(!reg(&a, &b, &usd, &usd, 5, 100, band)); // same asset
    assert!(!reg(&a, &b, &eur_a, &usd, 0, 100, band)); // zero fee
    assert!(!reg(&a, &b, &eur_a, &usd, 5, MAX_AMP + 1, band));
    assert!(!reg(&a, &b, &eur_a, &usd, 5, 100, (0, BAND_MAX))); // band must be > 0
    assert!(!reg(&a, &b, &eur_a, &usd, 5, 100, (BAND_MAX, BAND_MAX))); // min < max
    assert!(!reg(&a, &b, &eur_a, &usd, 5, 100, (BAND_MAX, BAND_MIN)));
    let six = s.e.register(SixDecimals, ());
    let (x, y) = if six < b { (six.clone(), b.clone()) } else { (b.clone(), six.clone()) };
    assert!(!reg(&x, &y, &eur_a, &usd, 5, 100, band)); // 6 vs 7 decimals
}

// ---------------------------------------------------------------- properties

/// Oracle value of a holding, in "base × 10^14" units.
fn value(a: i128, b: i128, price: i128) -> i128 {
    a * price + b * ONE
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(48))]

    /// Random pool (any ratio, any amp, any price), random swaps:
    /// 1. recorded reserves always equal real balances; 2. the trader pays/gets exactly what
    /// `swap` reports; 3. an immediate reverse swap never returns more than was put in.
    #[test]
    fn invariants_hold(
        ra in 10_000i128..1_000_000_000_000_000,
        rb in 10_000i128..1_000_000_000_000_000,
        price in 50_000_000_000_000i128..200_000_000_000_000,
        amp in prop::sample::select(std::vec![0u32, 1, 10, 100, 1_000, MAX_AMP]),
        swaps in proptest::collection::vec((any::<bool>(), 1i128..1_000_000_000_000_000), 1..8),
    ) {
        let s = setup_with(price, 1, amp);
        uncap(&s);
        let lp = Address::generate(&s.e);
        let trader = Address::generate(&s.e);
        fund(&s, &lp, ra.max(rb));
        fund(&s, &trader, 10_000_000_000_000_000);
        prop_assume!(s.pool.try_deposit(&lp, &ra, &rb, &0, &0).is_ok());

        for (a_to_b, amount) in swaps {
            let (t_in, t_out) = if a_to_b { (s.a.clone(), s.b.clone()) } else { (s.b.clone(), s.a.clone()) };
            let out_before = bal(&s, &t_out, &trader);
            let in_before = bal(&s, &t_in, &trader);
            let Ok(Ok(out)) = s.pool.try_swap(&trader, &trader, &t_in, &amount, &0) else { continue };
            let info = s.pool.info();
            prop_assert_eq!((bal(&s, &s.a, &s.pool.address), bal(&s, &s.b, &s.pool.address)), (info.reserve_a, info.reserve_b));
            prop_assert!(info.reserve_a > 0 && info.reserve_b > 0);
            prop_assert_eq!(bal(&s, &t_out, &trader) - out_before, out);
            prop_assert_eq!(in_before - bal(&s, &t_in, &trader), amount);
            if let Ok(Ok(back)) = s.pool.try_swap(&trader, &trader, &t_out, &out, &0) {
                prop_assert!(back < amount, "round trip {} -> {} -> {}", amount, out, back);
            }
        }
    }

    /// From a pool balanced at the oracle price, no sequence of swaps (split, reversed, mixed
    /// directions) leaves the trader with more oracle value than they started with.
    #[test]
    fn no_value_extraction_from_balanced_pool(
        size in 1_000_000i128..1_000_000_000_000_000,
        price in 50_000_000_000_000i128..200_000_000_000_000,
        amp in prop::sample::select(std::vec![0u32, 10, 100, 1_000, MAX_AMP]),
        swaps in proptest::collection::vec((any::<bool>(), 1u32..2_000), 1..12),
    ) {
        let s = setup_with(price, 1, amp);
        uncap(&s);
        let lp = Address::generate(&s.e);
        let trader = Address::generate(&s.e);
        let rb = size * price / ONE;
        prop_assume!(rb > 10_000);
        fund(&s, &lp, size.max(rb));
        fund(&s, &trader, 10 * size.max(rb));
        s.pool.deposit(&lp, &size, &rb, &0, &0);
        let start = value(bal(&s, &s.a, &trader), bal(&s, &s.b, &trader), price);
        for (a_to_b, permille) in swaps {
            // Trade size relative to the pool: 0.1‰ .. 200%.
            let (t_in, r_in) = if a_to_b { (s.a.clone(), s.pool.info().reserve_a) } else { (s.b.clone(), s.pool.info().reserve_b) };
            let amount = (r_in * permille as i128 / 1_000).max(1);
            let _ = s.pool.try_swap(&trader, &trader, &t_in, &amount, &0);
        }
        let end = value(bal(&s, &s.a, &trader), bal(&s, &s.b, &trader), price);
        prop_assert!(end <= start, "trader gained {} (value units)", end - start);
    }

    /// Deposit then immediately withdraw never returns more than was deposited, even after
    /// trading has skewed the pool.
    #[test]
    fn deposit_withdraw_no_free_money(
        ra in 10_000i128..1_000_000_000_000_000,
        rb in 10_000i128..1_000_000_000_000_000,
        swap_in in 1i128..1_000_000_000_000_000,
        da in 1i128..1_000_000_000_000_000,
        db in 1i128..1_000_000_000_000_000,
    ) {
        let s = setup_with(EUR_USD, 5, 100);
        uncap(&s);
        let lp = Address::generate(&s.e);
        let lp2 = Address::generate(&s.e);
        fund(&s, &lp, ra.max(rb).max(swap_in));
        fund(&s, &lp2, da.max(db));
        prop_assume!(s.pool.try_deposit(&lp, &ra, &rb, &0, &0).is_ok());
        let _ = s.pool.try_swap(&lp, &lp, &s.a, &swap_in, &0);
        let Ok(Ok((pa, pb, shares))) = s.pool.try_deposit(&lp2, &da, &db, &0, &0) else { return Ok(()) };
        let (wa, wb) = s.pool.withdraw(&lp2, &shares, &0, &0);
        prop_assert!(wa <= pa && wb <= pb, "deposited ({},{}) withdrew ({},{})", pa, pb, wa, wb);
    }
}

// ---------------------------------------------------------------- router entry points (v2)

#[test]
fn swap_in_prices_like_swap() {
    let s = setup();
    seed_balanced(&s);
    let trader = Address::generate(&s.e);
    fund(&s, &trader, 1_000 * UNIT);
    assert_eq!(s.pool.tokens(), (s.a.clone(), s.b.clone()));
    let q = s.pool.quote(&s.a, &(100 * UNIT));
    // Router style: input first, then the pool prices everything above its reserve.
    TokenClient::new(&s.e, &s.a).transfer(&trader, &s.pool.address, &(100 * UNIT));
    let out = s.pool.swap_in(&s.a, &q.amount_out, &trader);
    assert_eq!(out, q.amount_out);
    assert_eq!(bal(&s, &s.b, &trader), 1_000 * UNIT + out);
    let info = s.pool.info();
    assert_eq!(info.reserve_a, bal(&s, &s.a, &s.pool.address));
    assert_eq!(info.reserve_b, bal(&s, &s.b, &s.pool.address));
    // Nothing sent in → nothing to swap.
    assert_eq!(s.pool.try_swap_in(&s.a, &0, &trader), Err(Ok(err(FxPoolError::InvalidAmount))));
    assert_eq!(s.pool.try_swap_in(&s.a, &0, &s.pool.address), Err(Ok(err(FxPoolError::InvalidToken))));
}

#[test]
fn swap_in_respects_oracle_checks_and_pause() {
    let s = setup();
    seed_balanced(&s);
    let trader = Address::generate(&s.e);
    fund(&s, &trader, 1_000 * UNIT);
    TokenClient::new(&s.e, &s.a).transfer(&trader, &s.pool.address, &(10 * UNIT));
    s.e.ledger().set_timestamp(T0 + 10_000);
    assert_eq!(s.pool.try_swap_in(&s.a, &0, &trader), Err(Ok(err(FxPoolError::StalePrice))));
    s.e.ledger().set_timestamp(T0);
    s.pool.pause(&s.admin);
    assert!(s.pool.try_swap_in(&s.a, &0, &trader).is_err());
}

#[test]
fn deposit_raw_refunds_the_excess() {
    let s = setup();
    seed_balanced(&s);
    let user = Address::generate(&s.e);
    fund(&s, &user, 1_000 * UNIT);
    TokenClient::new(&s.e, &s.a).transfer(&user, &s.pool.address, &(100 * UNIT));
    TokenClient::new(&s.e, &s.b).transfer(&user, &s.pool.address, &(200 * UNIT));
    let (a, b, shares) = s.pool.deposit_raw(&user, &(100 * UNIT), &(110 * UNIT));
    assert_eq!((a, b), (100 * UNIT, 110 * UNIT));
    assert!(shares > 0 && s.pool.balance(&user) == shares);
    assert_eq!(bal(&s, &s.b, &user), 1_000 * UNIT - 110 * UNIT);
    let info = s.pool.info();
    assert_eq!(info.reserve_b, bal(&s, &s.b, &s.pool.address));
}

// ---------------------------------------------------------------- v3: outflow cap

mod v2 {
    soroban_sdk::contractimport!(file = "../../releases/lime_amm_fx_pool_v2.wasm");
}

mod v3 {
    soroban_sdk::contractimport!(file = "../../releases/lime_amm_fx_pool_v3.wasm");
}

fn expect_err<T: core::fmt::Debug, C, I: core::fmt::Debug>(
    r: Result<Result<T, C>, Result<soroban_sdk::Error, I>>,
) -> soroban_sdk::Error {
    match r {
        Err(Ok(e)) => e,
        other => panic!("expected a contract error, got {:?}", other.map(|_| ()).map_err(|e| e.err())),
    }
}

/// Keep the oracle fresh while time passes: one round every 300 s.
fn advance(s: &Setup, secs: u64) {
    for _ in 0..secs / 300 {
        push_price(s, EUR_USD);
    }
}

#[test]
fn outflow_cap_defaults_hit_and_reset() {
    let s = setup();
    let lp = seed_balanced(&s); // 1M A + 1.1M B
    assert_eq!(s.pool.outflow_cap(), OutflowCap { cap_bps: 2_000, window: 3_600 });
    let trader = Address::generate(&s.e);
    fund(&s, &trader, 10_000_000 * UNIT);

    // 20% of 1.1M B = 220k B may leave per hour. 150k EUR buys ~165k USD: fine.
    let out1 = s.pool.swap(&trader, &trader, &s.a, &(150_000 * UNIT), &0);
    let f = s.pool.flow();
    assert_eq!((f.start, f.base_a, f.base_b), (T0, 1_000_000 * UNIT, 1_100_000 * UNIT));
    assert_eq!((f.net_out_a, f.net_out_b), (-150_000 * UNIT, out1));
    // Another 60k EUR (~66k USD) would push net B outflow over 220k: swap and quote revert.
    let cap_err = err(FxPoolError::OutflowCapExceeded);
    assert_eq!(expect_err(s.pool.try_swap(&trader, &trader, &s.a, &(60_000 * UNIT), &0)), cap_err);
    assert_eq!(expect_err(s.pool.try_quote(&s.a, &(60_000 * UNIT))), cap_err);
    // Router path too.
    TokenClient::new(&s.e, &s.a).transfer(&trader, &s.pool.address, &(60_000 * UNIT));
    assert_eq!(expect_err(s.pool.try_swap_in(&s.a, &0, &trader)), cap_err);
    s.pool.skim(&trader);
    // Net, not gross: B flowing back in frees cap for B (and uses cap for A).
    s.pool.swap(&trader, &trader, &s.b, &(50_000 * UNIT), &0);
    s.pool.swap(&trader, &trader, &s.a, &(60_000 * UNIT), &0);

    // LPs are never capped or counted: deposits and a large exit work although the swap cap
    // is nearly used up, and the window is untouched.
    let f = s.pool.flow();
    s.pool.deposit(&lp, &(10_000 * UNIT), &(10_000 * UNIT), &0, &0);
    let shares = s.pool.balance(&lp);
    let (wa, wb) = s.pool.withdraw(&lp, &(shares / 2), &0, &0);
    assert!(wb > 220_000 * UNIT && wa > 0);
    assert_eq!(s.pool.flow(), f);
    // The allowance shrank with the pool: 20% of the (now ~half) B reserve is already used.
    assert_eq!(expect_err(s.pool.try_quote(&s.a, &(1_000 * UNIT))), cap_err);

    // New window after an hour: a fresh base from the current reserves.
    advance(&s, 3_600);
    let f = s.pool.flow();
    assert_eq!((f.start, f.net_out_a, f.net_out_b), (s.e.ledger().timestamp(), 0, 0));
    assert_eq!((f.base_a, f.base_b), (s.pool.info().reserve_a, s.pool.info().reserve_b));
    s.pool.swap(&trader, &trader, &s.a, &(60_000 * UNIT), &0);
}

#[test]
fn outflow_cap_admin_and_bounds() {
    let s = setup();
    seed_balanced(&s);
    let stranger = Address::generate(&s.e);
    let c = OutflowCap { cap_bps: 500, window: 600 };
    assert_eq!(expect_err(s.pool.try_set_outflow_cap(&stranger, &c)), err(FxPoolError::Unauthorized));
    for bad in [
        OutflowCap { cap_bps: 0, window: 600 },
        OutflowCap { cap_bps: 10_001, window: 600 },
        OutflowCap { cap_bps: 500, window: MIN_CAP_WINDOW - 1 },
        OutflowCap { cap_bps: 500, window: MAX_CAP_WINDOW + 1 },
    ] {
        assert_eq!(expect_err(s.pool.try_set_outflow_cap(&s.admin, &bad)), err(FxPoolError::InvalidParams));
    }
    s.pool.set_outflow_cap(&s.admin, &c);
    assert_eq!(s.pool.outflow_cap(), c);
    // 5% of 1.1M = 55k USD: 51k EUR (~56k USD) is over.
    assert_eq!(expect_err(s.pool.try_quote(&s.a, &(51_000 * UNIT))), err(FxPoolError::OutflowCapExceeded));
    s.pool.quote(&s.a, &(45_000 * UNIT));
}

/// The scenario the cap exists for: a feed that is wrong but inside the band and calm (no
/// breaker) quotes EUR 5% too high; an attacker sells EUR in a loop. Without the cap over half
/// of the USD side leaves; with it, at most 20% in the hour before the guardian pauses.
#[test]
fn outflow_cap_limits_a_plausible_wrong_feed() {
    let wrong = EUR_USD * 105 / 100;
    let run = |capped: bool| -> i128 {
        let s = setup_with(wrong, 5, 100);
        if !capped {
            uncap(&s);
        }
        seed_balanced(&s);
        let attacker = Address::generate(&s.e);
        fund(&s, &attacker, 10_000_000 * UNIT);
        for _ in 0..20 {
            let _ = s.pool.try_swap(&attacker, &attacker, &s.a, &(50_000 * UNIT), &0);
        }
        1_100_000 * UNIT - s.pool.info().reserve_b
    };
    let (capped, uncapped) = (run(true), run(false));
    assert!(capped <= 220_000 * UNIT, "capped outflow {}", capped);
    assert!(uncapped > 2 * capped && uncapped > 500_000 * UNIT, "uncapped outflow {}", uncapped);
}

// ---------------------------------------------------------------- v3: depeg guard

/// Token-price feed in USD with 8 decimals (different from the FX feed's 14, on purpose):
/// EURC at 1.10, USDC at 1.00.
fn peg_setup(s: &Setup) -> MockOracleClient<'static> {
    let id = s.e.register(MockOracle, (&s.admin, OAsset::Other(symbol_short!("USD")), 8u32, 300u32));
    let peg = MockOracleClient::new(&s.e, &id);
    let now = s.e.ledger().timestamp();
    peg.set_price(&OAsset::Other(symbol_short!("EURC")), &110_000_000, &now);
    peg.set_price(&OAsset::Other(symbol_short!("USDC")), &100_000_000, &now);
    peg
}

fn guard(peg: &Address, max_dev_bps: u32) -> PegGuard {
    PegGuard {
        oracle: peg.clone(),
        asset_a: PegAsset::Asset(Asset::Other(symbol_short!("EURC"))),
        asset_b: PegAsset::Asset(Asset::Other(symbol_short!("USDC"))),
        max_dev_bps,
        max_age: 900,
    }
}

#[test]
fn depeg_guard_trips_and_clears() {
    let s = setup();
    seed_balanced(&s);
    let peg = peg_setup(&s);
    let before = s.pool.quote(&s.a, &(1_000 * UNIT));
    s.pool.set_peg_guard(&s.admin, &Some(guard(&peg.address, 100)));
    assert_eq!(s.pool.peg_guard(), Some(guard(&peg.address, 100)));
    // On peg: the guard changes nothing.
    assert_eq!(s.pool.quote(&s.a, &(1_000 * UNIT)), before);
    let trader = Address::generate(&s.e);
    fund(&s, &trader, 10_000 * UNIT);
    s.pool.swap(&trader, &trader, &s.a, &(10 * UNIT), &0);

    let now = s.e.ledger().timestamp();
    let depeg = err(FxPoolError::Depegged);
    // USDC at 0.987: 1.3% off its USD reference, limit 1% → both directions revert.
    peg.set_price(&OAsset::Other(symbol_short!("USDC")), &98_700_000, &now);
    assert_eq!(expect_err(s.pool.try_quote(&s.a, &UNIT)), depeg);
    assert_eq!(expect_err(s.pool.try_swap(&trader, &trader, &s.b, &UNIT, &0)), depeg);
    // 0.991 is within 1%.
    peg.set_price(&OAsset::Other(symbol_short!("USDC")), &99_100_000, &now);
    s.pool.quote(&s.a, &UNIT);
    // EURC above its EUR reference (1.12 vs 1.10 = +1.8%) trips too.
    peg.set_price(&OAsset::Other(symbol_short!("EURC")), &112_000_000, &now);
    assert_eq!(expect_err(s.pool.try_quote(&s.b, &UNIT)), depeg);
    // Only checking USDC: the EURC deviation is ignored.
    let mut g = guard(&peg.address, 100);
    g.asset_a = PegAsset::Unchecked;
    s.pool.set_peg_guard(&s.admin, &Some(g));
    s.pool.quote(&s.b, &UNIT);
    // Stale peg price reverts like a stale FX price (withdrawals still work, see v2 tests).
    s.pool.set_peg_guard(&s.admin, &Some(guard(&peg.address, 300)));
    advance(&s, 1_200);
    assert_eq!(expect_err(s.pool.try_quote(&s.a, &UNIT)), err(FxPoolError::StalePrice));
    // Removing the guard restores v2 behaviour.
    s.pool.set_peg_guard(&s.admin, &None);
    assert_eq!(s.pool.peg_guard(), None);
    s.pool.quote(&s.a, &UNIT);
}

#[test]
fn depeg_guard_config_is_validated() {
    let s = setup();
    let peg = peg_setup(&s);
    let stranger = Address::generate(&s.e);
    let g = guard(&peg.address, 100);
    assert_eq!(expect_err(s.pool.try_set_peg_guard(&stranger, &Some(g.clone()))), err(FxPoolError::Unauthorized));
    let bad = |f: &dyn Fn(&mut PegGuard)| {
        let mut g = g.clone();
        f(&mut g);
        expect_err(s.pool.try_set_peg_guard(&s.admin, &Some(g)))
    };
    let invalid = err(FxPoolError::InvalidParams);
    assert_eq!(bad(&|g| g.max_dev_bps = 0), invalid);
    assert_eq!(bad(&|g| g.max_age = 0), invalid);
    assert_eq!(bad(&|g| { g.asset_a = PegAsset::Unchecked; g.asset_b = PegAsset::Unchecked }), invalid);
    // Asking the peg oracle for its own base is meaningless.
    assert_eq!(bad(&|g| g.asset_b = PegAsset::Asset(Asset::Other(symbol_short!("USD")))), invalid);
    // A token feed quoted in EUR can't be compared with the USD-based FX feed.
    let eur_based = s.e.register(MockOracle, (&s.admin, OAsset::Other(symbol_short!("EUR")), 8u32, 300u32));
    assert_eq!(bad(&|g| g.oracle = eur_based.clone()), invalid);
}

/// No peg guard configured: a v3 pool quotes exactly like a v2 pool (cap not reached).
#[test]
fn no_config_parity_with_v2() {
    let s = setup();
    seed_balanced(&s);
    let oracle = s.pool.info().oracle;
    let usd = Asset::Other(symbol_short!("USD"));
    let eur_a = Asset::Other(symbol_short!("EUR"));
    let old_id = s.e.register(
        v2::WASM,
        (&s.admin, &s.a, &s.b, &oracle, eur_a, usd, 5u32, 100u32, BAND_MIN, BAND_MAX),
    );
    let old = v2::Client::new(&s.e, &old_id);
    let lp = Address::generate(&s.e);
    fund(&s, &lp, 10_000_000 * UNIT);
    old.deposit(&lp, &(1_000_000 * UNIT), &(1_100_000 * UNIT), &0, &0);
    for amount in [1i128, 777, UNIT, 1_000 * UNIT, 100_000 * UNIT] {
        for t in [&s.a, &s.b] {
            let (n, o) = (s.pool.quote(t, &amount), old.quote(t, &amount));
            assert_eq!((n.amount_out, n.fee_bps, n.oracle_price), (o.amount_out, o.fee_bps, o.oracle_price));
        }
    }
    let trader = Address::generate(&s.e);
    fund(&s, &trader, 1_000_000 * UNIT);
    assert_eq!(
        s.pool.swap(&trader, &trader, &s.a, &(10_000 * UNIT), &0),
        old.swap(&trader, &trader, &s.a, &(10_000 * UNIT), &0)
    );
}

/// Upgrade a live v2 LimeFX in place: reserves, shares and params survive; the cap starts at
/// its default, no peg guard, no guardian; trading and exits keep working.
#[test]
fn upgrade_v2_to_v3_in_place() {
    let s = setup(); // only for env, tokens and oracle
    let oracle = s.pool.info().oracle;
    let id = s.e.register(
        v2::WASM,
        (
            &s.admin, &s.a, &s.b, &oracle,
            Asset::Other(symbol_short!("EUR")), Asset::Other(symbol_short!("USD")),
            5u32, 100u32, BAND_MIN, BAND_MAX,
        ),
    );
    let old = v2::Client::new(&s.e, &id);
    let lp = Address::generate(&s.e);
    fund(&s, &lp, 10_000_000 * UNIT);
    let (_, _, shares) = old.deposit(&lp, &(1_000_000 * UNIT), &(1_100_000 * UNIT), &0, &0);
    old.swap(&lp, &lp, &s.a, &(1_000 * UNIT), &0);
    let before = old.info();
    old.upgrade(&s.admin, &s.e.deployer().upload_contract_wasm(include_bytes!("../../../target/wasm32v1-none/release/lime_amm_fx_pool.wasm").as_slice()));

    let pool = LimeFxPoolClient::new(&s.e, &id);
    assert_eq!(pool.version(), VERSION);
    let after = pool.info();
    assert_eq!((after.reserve_a, after.reserve_b, after.total_shares), (before.reserve_a, before.reserve_b, before.total_shares));
    assert_eq!(after.params.amp, before.params.amp);
    assert_eq!(pool.balance(&lp), shares);
    assert_eq!(pool.admin(), s.admin);
    assert_eq!(pool.outflow_cap(), OutflowCap { cap_bps: DEFAULT_CAP_BPS, window: DEFAULT_CAP_WINDOW });
    assert_eq!((pool.peg_guard(), pool.guardian(), pool.pending_admin()), (None, None, None));
    pool.swap(&lp, &lp, &s.a, &(1_000 * UNIT), &0);
    pool.withdraw(&lp, &shares, &0, &0);
}

// ---------------------------------------------------------------- v3: admin transfer, guardian

#[test]
fn two_step_admin_and_guardian() {
    let s = setup();
    seed_balanced(&s);
    let new_admin = Address::generate(&s.e);
    let typo = Address::generate(&s.e);
    let guardian = Address::generate(&s.e);
    let unauthorized = err(FxPoolError::Unauthorized);

    // Proposal alone changes nothing; the wrong address can't accept; the admin can re-propose.
    s.pool.propose_admin(&s.admin, &typo);
    assert_eq!(s.pool.pending_admin(), Some(typo.clone()));
    assert_eq!(expect_err(s.pool.try_accept_admin(&new_admin)), unauthorized);
    s.pool.propose_admin(&s.admin, &new_admin);
    assert_eq!(expect_err(s.pool.try_accept_admin(&typo)), unauthorized);
    s.pool.accept_admin(&new_admin);
    assert_eq!((s.pool.admin(), s.pool.pending_admin()), (new_admin.clone(), None));
    // The old key has lost everything.
    let p = s.pool.info().params;
    assert_eq!(expect_err(s.pool.try_set_params(&s.admin, &p)), unauthorized);
    assert_eq!(expect_err(s.pool.try_pause(&s.admin)), unauthorized);
    assert_eq!(expect_err(s.pool.try_propose_admin(&s.admin, &s.admin)), unauthorized);

    // Guardian: pause only.
    assert_eq!(expect_err(s.pool.try_set_guardian(&guardian, &Some(guardian.clone()))), unauthorized);
    s.pool.set_guardian(&new_admin, &Some(guardian.clone()));
    assert_eq!(s.pool.guardian(), Some(guardian.clone()));
    s.pool.pause(&guardian);
    assert!(s.pool.paused());
    assert_eq!(expect_err(s.pool.try_unpause(&guardian)), unauthorized);
    assert_eq!(expect_err(s.pool.try_set_params(&guardian, &p)), unauthorized);
    let hash = BytesN::from_array(&s.e, &[0u8; 32]);
    assert_eq!(expect_err(s.pool.try_upgrade(&guardian, &hash)), unauthorized);
    s.pool.unpause(&new_admin);
    s.pool.set_guardian(&new_admin, &None);
    assert_eq!(expect_err(s.pool.try_pause(&guardian)), unauthorized);
}

// ---------------------------------------------------------------- v4: SEP-41 burn event

/// The `burn` events (SEP-41: topics ["burn", from], data { amount }) the pool published in
/// the last invocation, as (from, amount).
fn burn_events(e: &Env, pool: &Address) -> std::vec::Vec<(Address, i128)> {
    use soroban_sdk::{testutils::Events as _, xdr, Map, Symbol, TryFromVal, Val};
    let mut out = std::vec::Vec::new();
    for ev in e.events().all().filter_by_contract(pool).events() {
        let xdr::ContractEventBody::V0(body) = &ev.body;
        let topics: std::vec::Vec<Val> = body.topics.iter().map(|t| Val::try_from_val(e, t).unwrap()).collect();
        if topics.is_empty() || Symbol::try_from_val(e, &topics[0]).ok() != Some(Symbol::new(e, "burn")) {
            continue;
        }
        let from = Address::try_from_val(e, &topics[1]).unwrap();
        let data = Map::<Symbol, i128>::try_from_val(e, &Val::try_from_val(e, &body.data).unwrap()).unwrap();
        out.push((from, data.get(Symbol::new(e, "amount")).unwrap()));
    }
    out
}

#[test]
fn withdraw_emits_sep41_burn_event() {
    let s = setup();
    let lp = seed_balanced(&s);
    let shares = s.pool.balance(&lp);
    let supply = s.pool.total_supply();
    s.pool.withdraw(&lp, &(shares / 4), &0, &0);
    // One burn, for exactly the shares that left the supply, from the LP.
    assert_eq!(burn_events(&s.e, &s.pool.address), std::vec![(lp.clone(), shares / 4)]);
    assert_eq!(s.pool.total_supply(), supply - shares / 4);
    // Swaps and deposits burn nothing.
    s.pool.swap(&lp, &lp, &s.a, &(10 * UNIT), &0);
    assert!(burn_events(&s.e, &s.pool.address).is_empty());
    s.pool.deposit(&lp, &(10 * UNIT), &(11 * UNIT), &0, &0);
    assert!(burn_events(&s.e, &s.pool.address).is_empty());
}

/// Upgrade the live v3 LimeFX (governed: timelock admin, guardian, custom cap) in place: every
/// setting, reserve and share survives, and withdrawals now emit `burn`.
#[test]
fn upgrade_v3_to_v4_in_place() {
    let s = setup(); // only for env, tokens and oracle
    let oracle = s.pool.info().oracle;
    let id = s.e.register(
        v3::WASM,
        (
            &s.admin, &s.a, &s.b, &oracle,
            Asset::Other(symbol_short!("EUR")), Asset::Other(symbol_short!("USD")),
            5u32, 100u32, BAND_MIN, BAND_MAX,
        ),
    );
    let old = v3::Client::new(&s.e, &id);
    let lp = Address::generate(&s.e);
    fund(&s, &lp, 10_000_000 * UNIT);
    let (_, _, shares) = old.deposit(&lp, &(1_000_000 * UNIT), &(1_100_000 * UNIT), &0, &0);
    old.swap(&lp, &lp, &s.a, &(1_000 * UNIT), &0);
    // As on Testnet: admin handed to a timelock, a pause-only guardian, a custom cap.
    let timelock = Address::generate(&s.e);
    let guardian = Address::generate(&s.e);
    old.set_outflow_cap(&s.admin, &v3::OutflowCap { cap_bps: 1_500, window: 1_800 });
    old.set_guardian(&s.admin, &Some(guardian.clone()));
    old.propose_admin(&s.admin, &timelock);
    old.accept_admin(&timelock);
    let before = old.info();
    old.withdraw(&lp, &(shares / 10), &0, &0);
    assert!(burn_events(&s.e, &id).is_empty()); // the v3 gap this release closes
    old.upgrade(&timelock, &s.e.deployer().upload_contract_wasm(include_bytes!("../../../target/wasm32v1-none/release/lime_amm_fx_pool.wasm").as_slice()));

    let pool = LimeFxPoolClient::new(&s.e, &id);
    assert_eq!(pool.version(), 4);
    let after = pool.info();
    assert_eq!(after.params.amp, before.params.amp);
    assert_eq!(pool.admin(), timelock);
    assert_eq!(pool.guardian(), Some(guardian));
    assert_eq!(pool.outflow_cap(), OutflowCap { cap_bps: 1_500, window: 1_800 });
    assert_eq!(pool.balance(&lp), shares - shares / 10);
    pool.swap(&lp, &lp, &s.a, &(1_000 * UNIT), &0);
    pool.withdraw(&lp, &(shares / 10), &0, &0);
    assert_eq!(burn_events(&s.e, &id), std::vec![(lp.clone(), shares / 10)]);
}
