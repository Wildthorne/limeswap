#![no_std]
//! Mock SEP-40 price oracle for tests and the local network.
//!
//! Same `Asset` / `PriceData` shapes as Reflector (and SEP-40), so a consumer written against
//! the SEP-40 subset (`base`, `assets`, `decimals`, `resolution`, `price`, `prices`, `lastprice`)
//! works against either. The admin pushes prices with `set_price`; each asset keeps the newest
//! `MAX_HISTORY` records.
//!
//! One deliberate difference from Reflector v7: `prices(asset, n)` returns at most `n` records
//! (what SEP-40 says). Reflector returns up to `n + 1` (it includes the record at the lower
//! boundary for interpolation). Consumers should accept any length.

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error, Address,
    Env, Symbol, Vec,
};

pub const VERSION: u32 = 1;
/// Records kept per asset (Reflector also caps `prices` at 20 records).
pub const MAX_HISTORY: u32 = 20;

const DAY_IN_LEDGERS: u32 = 17_280;
const TTL_THRESHOLD: u32 = 7 * DAY_IN_LEDGERS;
const TTL_EXTEND_TO: u32 = 30 * DAY_IN_LEDGERS;

/// SEP-40 asset: a Stellar asset (its contract address) or an off-chain symbol ("EUR", "BTC").
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd)]
pub enum Asset {
    Stellar(Address),
    Other(Symbol),
}

/// SEP-40 price record: `price` in the base asset with `decimals()` decimals.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq, Ord, PartialOrd)]
pub struct PriceData {
    pub price: i128,
    pub timestamp: u64,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum OracleError {
    Unauthorized = 1,
    InvalidPrice = 2,
    /// Timestamps must not go backwards.
    InvalidTimestamp = 3,
    /// The base asset is always worth exactly 1 and cannot be set.
    BaseAsset = 4,
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Admin,
    Base,
    Decimals,
    Resolution,
    Assets,
    LastTimestamp,
    /// Newest record first.
    History(Asset),
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PriceSet {
    #[topic]
    pub asset: Asset,
    pub price: i128,
    pub timestamp: u64,
}

fn bump(e: &Env) {
    e.storage().instance().extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);
}

fn base(e: &Env) -> Asset {
    e.storage().instance().get(&DataKey::Base).unwrap()
}

fn decimals(e: &Env) -> u32 {
    e.storage().instance().get(&DataKey::Decimals).unwrap()
}

fn history(e: &Env, asset: &Asset) -> Vec<PriceData> {
    e.storage().persistent().get(&DataKey::History(asset.clone())).unwrap_or(Vec::new(e))
}

/// The base asset is quoted as exactly 1 at the current time (Reflector does the same).
fn base_record(e: &Env) -> PriceData {
    PriceData { price: 10i128.pow(decimals(e)), timestamp: e.ledger().timestamp() }
}

#[contract]
pub struct MockOracle;

#[contractimpl]
impl MockOracle {
    pub fn __constructor(e: &Env, admin: Address, base: Asset, decimals: u32, resolution: u32) {
        let st = e.storage().instance();
        st.set(&DataKey::Admin, &admin);
        st.set(&DataKey::Base, &base);
        st.set(&DataKey::Decimals, &decimals);
        st.set(&DataKey::Resolution, &resolution);
        st.set(&DataKey::Assets, &Vec::<Asset>::new(e));
        st.set(&DataKey::LastTimestamp, &0u64);
    }

    // ---------------------------------------------------------------- SEP-40

    pub fn base(e: &Env) -> Asset {
        base(e)
    }

    pub fn assets(e: &Env) -> Vec<Asset> {
        e.storage().instance().get(&DataKey::Assets).unwrap()
    }

    pub fn decimals(e: &Env) -> u32 {
        decimals(e)
    }

    /// Seconds between price updates.
    pub fn resolution(e: &Env) -> u32 {
        e.storage().instance().get(&DataKey::Resolution).unwrap()
    }

    /// Record with exactly this timestamp, if still in history.
    pub fn price(e: &Env, asset: Asset, timestamp: u64) -> Option<PriceData> {
        if asset == base(e) {
            return Some(PriceData { timestamp, ..base_record(e) });
        }
        history(e, &asset).iter().find(|p| p.timestamp == timestamp)
    }

    /// Newest `records` records, newest first. None if the asset has no prices.
    pub fn prices(e: &Env, asset: Asset, records: u32) -> Option<Vec<PriceData>> {
        if records == 0 {
            return None;
        }
        if asset == base(e) {
            let mut v = Vec::new(e);
            v.push_back(base_record(e));
            return Some(v);
        }
        let h = history(e, &asset);
        if h.is_empty() {
            return None;
        }
        Some(h.slice(0..records.min(h.len())))
    }

    pub fn lastprice(e: &Env, asset: Asset) -> Option<PriceData> {
        if asset == base(e) {
            return Some(base_record(e));
        }
        history(e, &asset).first()
    }

    // ---------------------------------------------------------------- Reflector extras

    pub fn last_timestamp(e: &Env) -> u64 {
        e.storage().instance().get(&DataKey::LastTimestamp).unwrap()
    }

    pub fn version(_e: &Env) -> u32 {
        VERSION
    }

    pub fn admin(e: &Env) -> Address {
        e.storage().instance().get(&DataKey::Admin).unwrap()
    }

    // ---------------------------------------------------------------- admin

    /// Push a new price for `asset` (becomes the newest record). Timestamps must not go back;
    /// the same timestamp overwrites the newest record.
    pub fn set_price(e: &Env, asset: Asset, price: i128, timestamp: u64) {
        let admin: Address = e.storage().instance().get(&DataKey::Admin).unwrap();
        admin.require_auth();
        bump(e);
        if asset == base(e) {
            panic_with_error!(e, OracleError::BaseAsset);
        }
        if price <= 0 {
            panic_with_error!(e, OracleError::InvalidPrice);
        }
        let mut h = history(e, &asset);
        if let Some(newest) = h.first() {
            if timestamp < newest.timestamp {
                panic_with_error!(e, OracleError::InvalidTimestamp);
            }
            if timestamp == newest.timestamp {
                h.pop_front();
            }
        } else {
            let mut assets = Self::assets(e);
            assets.push_back(asset.clone());
            e.storage().instance().set(&DataKey::Assets, &assets);
        }
        h.push_front(PriceData { price, timestamp });
        while h.len() > MAX_HISTORY {
            h.pop_back();
        }
        let key = DataKey::History(asset.clone());
        e.storage().persistent().set(&key, &h);
        e.storage().persistent().extend_ttl(&key, TTL_THRESHOLD, TTL_EXTEND_TO);
        if timestamp > Self::last_timestamp(e) {
            e.storage().instance().set(&DataKey::LastTimestamp, &timestamp);
        }
        PriceSet { asset, price, timestamp }.publish(e);
    }
}

#[cfg(test)]
mod test {
    extern crate std;
    use super::*;
    use soroban_sdk::{symbol_short, testutils::{Address as _, Ledger}};

    fn setup() -> (Env, MockOracleClient<'static>) {
        let e = Env::default();
        e.mock_all_auths();
        e.ledger().set_timestamp(10_000);
        let admin = Address::generate(&e);
        let id = e.register(MockOracle, (&admin, Asset::Other(symbol_short!("USD")), 14u32, 300u32));
        (e.clone(), MockOracleClient::new(&e, &id))
    }

    #[test]
    fn sep40_views_and_history_newest_first() {
        let (e, o) = setup();
        let eur = Asset::Other(symbol_short!("EUR"));
        assert_eq!(o.base(), Asset::Other(symbol_short!("USD")));
        assert_eq!((o.decimals(), o.resolution()), (14, 300));
        assert_eq!(o.lastprice(&eur), None);
        assert_eq!(o.prices(&eur, &5), None);
        for i in 0..25u64 {
            o.set_price(&eur, &(110_000_000_000_000 + i as i128), &(9_000 + i * 300));
        }
        assert_eq!(o.assets().len(), 1);
        let last = o.lastprice(&eur).unwrap();
        assert_eq!(last, PriceData { price: 110_000_000_000_024, timestamp: 9_000 + 24 * 300 });
        let h = o.prices(&eur, &3).unwrap();
        assert_eq!(h.len(), 3);
        assert_eq!(h.get(0).unwrap(), last);
        assert!(h.get(1).unwrap().timestamp < h.get(0).unwrap().timestamp);
        assert_eq!(o.prices(&eur, &100).unwrap().len(), MAX_HISTORY);
        assert_eq!(o.price(&eur, &(9_000 + 23 * 300)).unwrap().price, 110_000_000_000_023);
        // Base asset is always 1.0 at the current time.
        let usd = o.lastprice(&Asset::Other(symbol_short!("USD"))).unwrap();
        assert_eq!(usd, PriceData { price: 100_000_000_000_000, timestamp: e.ledger().timestamp() });
        assert_eq!(o.last_timestamp(), 9_000 + 24 * 300);
    }

    #[test]
    fn same_timestamp_overwrites_and_time_never_goes_back() {
        let (_e, o) = setup();
        let eur = Asset::Other(symbol_short!("EUR"));
        o.set_price(&eur, &100, &1_000);
        o.set_price(&eur, &200, &1_000);
        assert_eq!(o.prices(&eur, &5).unwrap().len(), 1);
        assert_eq!(o.lastprice(&eur).unwrap().price, 200);
        assert_eq!(o.try_set_price(&eur, &300, &999), Err(Ok(OracleError::InvalidTimestamp.into())));
        assert_eq!(o.try_set_price(&eur, &0, &2_000), Err(Ok(OracleError::InvalidPrice.into())));
        let usd = Asset::Other(symbol_short!("USD"));
        assert_eq!(o.try_set_price(&usd, &1, &2_000), Err(Ok(OracleError::BaseAsset.into())));
    }
}
