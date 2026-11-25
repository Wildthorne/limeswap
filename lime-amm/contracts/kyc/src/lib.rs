#![no_std]
//! Mock KYC desk for LFUND on Testnet: anyone can "pass KYC" by signing `verify`, which approves
//! their LFUND trustline and pays a small starter grant. TESTNET DEMO ONLY: a real issuer would
//! approve accounts after a KYC check (SEP-12) or co-sign each transfer (SEP-8).
//!
//! How it works: the desk is the admin of LFUND's Stellar Asset Contract (`set_admin`), so it can
//! call the SAC's admin functions (`set_authorized`, `mint`, `clawback`) itself. The issuer keeps
//! control through pass-through functions that need the issuer's signature:
//! - `set_status`: approve or freeze anyone; a frozen (Revoked) account can't self-verify again.
//! - `mint`, `clawback`, `set_grant`.
//! - `pool_set_compliance`, `pool_force_redeem`: LimeSwap pools check the SAC admin, which is now
//!   this desk, so the issuer's pool powers go through here too.
//! - `set_sac_admin`: hand the admin role back (escape hatch).
//!
//! Freeze accounts through `set_status`, not a classic SetTrustLineFlags: the desk only knows the
//! statuses it recorded.

use soroban_sdk::{
    contract, contractclient, contracterror, contractevent, contractimpl, contracttype, panic_with_error,
    token::StellarAssetClient, Address, Env,
};

#[cfg(test)]
mod test;

pub const VERSION: u32 = 1;
const DAY_IN_LEDGERS: u32 = 17_280;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum KycError {
    /// This account is already verified.
    AlreadyVerified = 1,
    /// The issuer froze this account; it can't self-verify.
    Revoked = 2,
    /// The account has no trustline for the token yet, so it can't be approved.
    NoTrustline = 3,
    InvalidAmount = 4,
}

#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum KycStatus {
    Unverified = 0,
    Verified = 1,
    Revoked = 2,
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Issuer,
    Token,
    Grant,
    Status(Address),
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Verified {
    #[topic]
    pub user: Address,
    pub grant: i128,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StatusSet {
    #[topic]
    pub user: Address,
    pub status: KycStatus,
}

/// The LimeSwap pool functions the issuer (= SAC admin) may call.
#[contractclient(name = "PoolClient")]
pub trait Pool {
    fn set_compliance(e: Env, token: Address, enabled: bool);
    fn force_redeem(e: Env, token: Address, holder: Address, to: Address, release_other: bool) -> (i128, i128);
}

fn sac(e: &Env) -> StellarAssetClient<'_> {
    StellarAssetClient::new(e, &e.storage().instance().get::<_, Address>(&DataKey::Token).unwrap())
}

fn require_issuer(e: &Env) {
    e.storage().instance().get::<_, Address>(&DataKey::Issuer).unwrap().require_auth();
    bump(e);
}

fn bump(e: &Env) {
    e.storage().instance().extend_ttl(7 * DAY_IN_LEDGERS, 30 * DAY_IN_LEDGERS);
}

fn record(e: &Env, user: &Address, status: KycStatus) {
    let key = DataKey::Status(user.clone());
    e.storage().persistent().set(&key, &status);
    e.storage().persistent().extend_ttl(&key, 30 * DAY_IN_LEDGERS, 120 * DAY_IN_LEDGERS);
    StatusSet { user: user.clone(), status }.publish(e);
}

#[contract]
pub struct KycDesk;

#[contractimpl]
impl KycDesk {
    /// `token` is the SAC of an AUTH_REQUIRED asset issued by `issuer`. The issuer must then call
    /// the SAC's `set_admin(<this desk>)` for the desk to work.
    pub fn __constructor(e: &Env, issuer: Address, token: Address, grant: i128) {
        if grant < 0 {
            panic_with_error!(e, KycError::InvalidAmount);
        }
        let st = e.storage().instance();
        st.set(&DataKey::Issuer, &issuer);
        st.set(&DataKey::Token, &token);
        st.set(&DataKey::Grant, &grant);
    }

    /// Self-service mock KYC: creates `user`'s trustline if needed (classic accounts pay its
    /// 0.5 XLM reserve), approves it and pays the starter grant. Once per account.
    pub fn verify(e: &Env, user: Address) -> i128 {
        user.require_auth();
        bump(e);
        match Self::status(e, user.clone()) {
            KycStatus::Verified => panic_with_error!(e, KycError::AlreadyVerified),
            KycStatus::Revoked => panic_with_error!(e, KycError::Revoked),
            KycStatus::Unverified => {}
        }
        let t = sac(e);
        t.trust(&user);
        t.set_authorized(&user, &true);
        let grant = Self::grant(e);
        if grant > 0 {
            t.mint(&user, &grant);
        }
        record(e, &user, KycStatus::Verified);
        Verified { user, grant }.publish(e);
        grant
    }

    pub fn status(e: &Env, user: Address) -> KycStatus {
        e.storage().persistent().get(&DataKey::Status(user)).unwrap_or(KycStatus::Unverified)
    }

    pub fn issuer(e: &Env) -> Address {
        e.storage().instance().get(&DataKey::Issuer).unwrap()
    }

    pub fn token(e: &Env) -> Address {
        e.storage().instance().get(&DataKey::Token).unwrap()
    }

    pub fn grant(e: &Env) -> i128 {
        e.storage().instance().get(&DataKey::Grant).unwrap()
    }

    pub fn version(_e: &Env) -> u32 {
        VERSION
    }

    // ---- issuer only ----

    /// Approve (`true`) or freeze (`false`) `user`. Freezing an account without a trustline just
    /// records it as Revoked, so it can't self-verify later.
    pub fn set_status(e: &Env, user: Address, verified: bool) {
        require_issuer(e);
        let res = sac(e).try_set_authorized(&user, &verified);
        if verified && res.is_err() {
            panic_with_error!(e, KycError::NoTrustline);
        }
        record(e, &user, if verified { KycStatus::Verified } else { KycStatus::Revoked });
    }

    pub fn set_grant(e: &Env, amount: i128) {
        require_issuer(e);
        if amount < 0 {
            panic_with_error!(e, KycError::InvalidAmount);
        }
        e.storage().instance().set(&DataKey::Grant, &amount);
    }

    pub fn mint(e: &Env, to: Address, amount: i128) {
        require_issuer(e);
        sac(e).mint(&to, &amount);
    }

    pub fn clawback(e: &Env, from: Address, amount: i128) {
        require_issuer(e);
        sac(e).clawback(&from, &amount);
    }

    /// Hand the SAC admin role to someone else (e.g. back to the issuer). The desk stops working.
    pub fn set_sac_admin(e: &Env, new_admin: Address) {
        require_issuer(e);
        sac(e).set_admin(&new_admin);
    }

    pub fn pool_set_compliance(e: &Env, pool: Address, enabled: bool) {
        require_issuer(e);
        PoolClient::new(e, &pool).set_compliance(&Self::token(e), &enabled);
    }

    pub fn pool_force_redeem(e: &Env, pool: Address, holder: Address, to: Address, release_other: bool) -> (i128, i128) {
        require_issuer(e);
        PoolClient::new(e, &pool).force_redeem(&Self::token(e), &holder, &to, &release_other)
    }
}
