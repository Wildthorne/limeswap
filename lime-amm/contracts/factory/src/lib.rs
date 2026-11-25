#![no_std]
//! LimeSwap factory: deploys one pool per (token_a, token_b, fee tier) at a deterministic address
//! and keeps the registry. Pool creation is permissionless; the factory's admin *at creation
//! time* becomes the new pool's admin (pause/upgrade). Existing pools keep their own admin, so an
//! admin change here must be repeated on every pool (`governance.sh` does both).
//!
//! v2: two-step admin transfer (`propose_admin` + `accept_admin`), so the admin can move to a
//! timelock contract; pools created afterwards get the new admin.

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error, xdr::ToXdr, ContractExecutable,
    Address, Bytes, BytesN, Env, Vec,
};
use stellar_contract_utils::upgradeable;

#[cfg(test)]
mod test;

pub const VERSION: u32 = 2;
/// Allowed fee tiers in basis points: 0.05% (stable pairs), 0.3% (standard, same as classic pools), 1% (exotic).
pub const FEE_TIERS: [u32; 3] = [5, 30, 100];

const DAY_IN_LEDGERS: u32 = 17_280;
const TTL_THRESHOLD: u32 = 7 * DAY_IN_LEDGERS;
const TTL_EXTEND_TO: u32 = 30 * DAY_IN_LEDGERS;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum FactoryError {
    Unauthorized = 1,
    SameToken = 2,
    InvalidFee = 3,
    PoolExists = 4,
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Admin,
    PoolWasm,
    PoolCount,
    /// (token_a, token_b, fee_bps) with token_a < token_b → pool address
    Pool(Address, Address, u32),
    /// index → pool address, for enumeration
    PoolAt(u32),
    /// v2: proposed new admin (two-step transfer).
    PendingAdmin,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PoolCreated {
    #[topic]
    pub token_a: Address,
    #[topic]
    pub token_b: Address,
    pub fee_bps: u32,
    pub pool: Address,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdminProposed {
    pub current: Address,
    pub pending: Address,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdminChanged {
    pub previous: Address,
    pub admin: Address,
}

pub fn sort(a: Address, b: Address) -> (Address, Address) {
    if a < b {
        (a, b)
    } else {
        (b, a)
    }
}

fn require_admin(e: &Env, caller: &Address) {
    caller.require_auth();
    let admin: Address = e.storage().instance().get(&DataKey::Admin).unwrap();
    if admin != *caller {
        panic_with_error!(e, FactoryError::Unauthorized);
    }
}

fn bump_persistent(e: &Env, key: &DataKey) {
    e.storage().persistent().extend_ttl(key, TTL_THRESHOLD, TTL_EXTEND_TO);
}

#[contract]
pub struct LimeSwapFactory;

#[contractimpl]
impl LimeSwapFactory {
    pub fn __constructor(e: &Env, admin: Address, pool_wasm_hash: BytesN<32>) {
        e.storage().instance().set(&DataKey::Admin, &admin);
        e.storage().instance().set(&DataKey::PoolWasm, &pool_wasm_hash);
        e.storage().instance().set(&DataKey::PoolCount, &0u32);
    }

    /// Deploy a new pool. Anyone may call; one pool per (pair, fee tier).
    pub fn create_pool(e: &Env, token_a: Address, token_b: Address, fee_bps: u32) -> Address {
        e.storage().instance().extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);
        if token_a == token_b {
            panic_with_error!(e, FactoryError::SameToken);
        }
        if !FEE_TIERS.contains(&fee_bps) {
            panic_with_error!(e, FactoryError::InvalidFee);
        }
        let (a, b) = sort(token_a, token_b);
        let key = DataKey::Pool(a.clone(), b.clone(), fee_bps);
        if e.storage().persistent().has(&key) {
            panic_with_error!(e, FactoryError::PoolExists);
        }

        let mut salt_src = Bytes::new(e);
        salt_src.append(&a.clone().to_xdr(e));
        salt_src.append(&b.clone().to_xdr(e));
        salt_src.append(&Bytes::from_array(e, &fee_bps.to_be_bytes()));
        let salt: BytesN<32> = e.crypto().sha256(&salt_src).into();

        let admin: Address = e.storage().instance().get(&DataKey::Admin).unwrap();
        let wasm: BytesN<32> = e.storage().instance().get(&DataKey::PoolWasm).unwrap();
        let pool = e
            .deployer()
            .with_current_contract(salt)
            .deploy_contract(ContractExecutable::Wasm(wasm), (admin, a.clone(), b.clone(), fee_bps));

        let count: u32 = e.storage().instance().get(&DataKey::PoolCount).unwrap_or(0);
        e.storage().persistent().set(&key, &pool);
        bump_persistent(e, &key);
        let at = DataKey::PoolAt(count);
        e.storage().persistent().set(&at, &pool);
        bump_persistent(e, &at);
        e.storage().instance().set(&DataKey::PoolCount, &(count + 1));

        PoolCreated { token_a: a, token_b: b, fee_bps, pool: pool.clone() }.publish(e);
        pool
    }

    pub fn get_pool(e: &Env, token_a: Address, token_b: Address, fee_bps: u32) -> Option<Address> {
        let (a, b) = sort(token_a, token_b);
        e.storage().persistent().get(&DataKey::Pool(a, b, fee_bps))
    }

    pub fn pool_count(e: &Env) -> u32 {
        e.storage().instance().get(&DataKey::PoolCount).unwrap_or(0)
    }

    /// Page through all pools: indexes [start, start+limit).
    pub fn pools(e: &Env, start: u32, limit: u32) -> Vec<Address> {
        let count = Self::pool_count(e);
        let end = count.min(start.saturating_add(limit));
        let mut out = Vec::new(e);
        for i in start..end {
            if let Some(p) = e.storage().persistent().get(&DataKey::PoolAt(i)) {
                out.push_back(p);
            }
        }
        out
    }

    pub fn fee_tiers(e: &Env) -> Vec<u32> {
        Vec::from_array(e, FEE_TIERS)
    }

    pub fn pool_wasm_hash(e: &Env) -> BytesN<32> {
        e.storage().instance().get(&DataKey::PoolWasm).unwrap()
    }

    pub fn admin(e: &Env) -> Address {
        e.storage().instance().get(&DataKey::Admin).unwrap()
    }

    pub fn version(_e: &Env) -> u32 {
        VERSION
    }

    /// New pools use this code; existing pools are upgraded one by one via `pool.upgrade`.
    pub fn set_pool_wasm(e: &Env, caller: Address, pool_wasm_hash: BytesN<32>) {
        require_admin(e, &caller);
        e.storage().instance().set(&DataKey::PoolWasm, &pool_wasm_hash);
    }

    /// v2: step 1 of an admin transfer; the new admin must `accept_admin`. Until then the
    /// current admin keeps all rights and can overwrite the proposal.
    pub fn propose_admin(e: &Env, caller: Address, new_admin: Address) {
        require_admin(e, &caller);
        e.storage().instance().extend_ttl(TTL_THRESHOLD, TTL_EXTEND_TO);
        e.storage().instance().set(&DataKey::PendingAdmin, &new_admin);
        AdminProposed { current: caller, pending: new_admin }.publish(e);
    }

    /// v2: step 2: the proposed admin takes over (a timelock does this via an executed operation).
    pub fn accept_admin(e: &Env, new_admin: Address) {
        new_admin.require_auth();
        let st = e.storage().instance();
        if st.get::<_, Address>(&DataKey::PendingAdmin) != Some(new_admin.clone()) {
            panic_with_error!(e, FactoryError::Unauthorized);
        }
        let previous: Address = st.get(&DataKey::Admin).unwrap();
        st.set(&DataKey::Admin, &new_admin);
        st.remove(&DataKey::PendingAdmin);
        AdminChanged { previous, admin: new_admin }.publish(e);
    }

    pub fn pending_admin(e: &Env) -> Option<Address> {
        e.storage().instance().get(&DataKey::PendingAdmin)
    }

    pub fn upgrade(e: &Env, caller: Address, new_wasm_hash: BytesN<32>) {
        require_admin(e, &caller);
        upgradeable::upgrade(e, &new_wasm_hash);
    }
}
