#![no_std]
//! Testnet faucet for the public LimeSwap demo: anyone can claim a fixed amount of each demo token
//! once per cooldown. It holds the tokens itself, so the website needs no secret key (an issuer key
//! in a public frontend could mint without limit). Test tokens only; refilled by plain transfers.
//!
//! - `claim(to)`: `to` must sign (so nobody can burn someone else's cooldown) and must already be
//!   able to hold each token (trustlines for classic assets), or the whole claim reverts.
//! - Admin (`lime-owner`) sets the drip list and cooldown and can take tokens back.

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error, token::TokenClient,
    Address, Env, Vec,
};

#[cfg(test)]
mod test;

pub const VERSION: u32 = 1;
const DAY_IN_LEDGERS: u32 = 17_280;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum FaucetError {
    Unauthorized = 1,
    /// This address claimed less than `cooldown` seconds ago.
    TooSoon = 2,
    /// The faucet ran dry for at least one token (ask the admin to refill).
    Empty = 3,
    InvalidDrip = 4,
}

/// One token and how much of it a claim pays.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Drip {
    pub token: Address,
    pub amount: i128,
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Admin,
    Drips,
    Cooldown,
    LastClaim(Address),
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Claimed {
    #[topic]
    pub to: Address,
    pub drips: Vec<Drip>,
}

fn require_admin(e: &Env, caller: &Address) {
    caller.require_auth();
    let admin: Address = e.storage().instance().get(&DataKey::Admin).unwrap();
    if admin != *caller {
        panic_with_error!(e, FaucetError::Unauthorized);
    }
}

fn check_drips(e: &Env, drips: &Vec<Drip>) {
    if drips.is_empty() || drips.iter().any(|d| d.amount <= 0) {
        panic_with_error!(e, FaucetError::InvalidDrip);
    }
}

fn bump(e: &Env) {
    e.storage().instance().extend_ttl(7 * DAY_IN_LEDGERS, 30 * DAY_IN_LEDGERS);
}

#[contract]
pub struct Faucet;

#[contractimpl]
impl Faucet {
    pub fn __constructor(e: &Env, admin: Address, drips: Vec<Drip>, cooldown: u64) {
        check_drips(e, &drips);
        let st = e.storage().instance();
        st.set(&DataKey::Admin, &admin);
        st.set(&DataKey::Drips, &drips);
        st.set(&DataKey::Cooldown, &cooldown);
    }

    /// Pay every drip to `to`. Reverts as a whole if `to` claimed within the cooldown, can't hold
    /// one of the tokens (no trustline), or the faucet is short of one of them.
    pub fn claim(e: &Env, to: Address) -> Vec<Drip> {
        to.require_auth();
        bump(e);
        let now = e.ledger().timestamp();
        let key = DataKey::LastClaim(to.clone());
        if let Some(last) = e.storage().persistent().get::<_, u64>(&key) {
            if now < last + Self::cooldown(e) {
                panic_with_error!(e, FaucetError::TooSoon);
            }
        }
        let me = e.current_contract_address();
        let drips = Self::drips(e);
        for d in drips.iter() {
            let t = TokenClient::new(e, &d.token);
            if t.balance(&me) < d.amount {
                panic_with_error!(e, FaucetError::Empty);
            }
            t.transfer(&me, &to, &d.amount);
        }
        e.storage().persistent().set(&key, &now);
        e.storage().persistent().extend_ttl(&key, DAY_IN_LEDGERS, 2 * DAY_IN_LEDGERS);
        Claimed { to, drips: drips.clone() }.publish(e);
        drips
    }

    /// Unix time from which `who` may claim again (0 = now).
    pub fn next_claim(e: &Env, who: Address) -> u64 {
        e.storage()
            .persistent()
            .get::<_, u64>(&DataKey::LastClaim(who))
            .map(|last| last + Self::cooldown(e))
            .unwrap_or(0)
    }

    pub fn drips(e: &Env) -> Vec<Drip> {
        e.storage().instance().get(&DataKey::Drips).unwrap()
    }

    pub fn cooldown(e: &Env) -> u64 {
        e.storage().instance().get(&DataKey::Cooldown).unwrap()
    }

    pub fn version(_e: &Env) -> u32 {
        VERSION
    }

    pub fn set_drips(e: &Env, caller: Address, drips: Vec<Drip>, cooldown: u64) {
        require_admin(e, &caller);
        check_drips(e, &drips);
        e.storage().instance().set(&DataKey::Drips, &drips);
        e.storage().instance().set(&DataKey::Cooldown, &cooldown);
    }

    /// Take `amount` of `token` back out of the faucet.
    pub fn withdraw(e: &Env, caller: Address, token: Address, amount: i128, to: Address) {
        require_admin(e, &caller);
        TokenClient::new(e, &token).transfer(&e.current_contract_address(), &to, &amount);
    }
}
