#![cfg(test)]
//! End to end: the timelock becomes admin of a LimeSwap pool, LimeFX and the factory (two-step
//! transfer), the old key loses its powers, upgrades / params go through schedule → wait →
//! execute, a canceller can veto, and the guardian can still pause instantly.
extern crate std;

use super::*;
use lime_amm_mock_oracle::{Asset as OAsset, MockOracle, MockOracleClient};
use soroban_sdk::{
    testutils::{Address as _, BytesN as _, Ledger},
    token::StellarAssetClient,
    vec, Address, BytesN, Env, IntoVal, Symbol, Val, Vec,
};
use stellar_governance::timelock::OperationState;

mod pool {
    soroban_sdk::contractimport!(file = "../../target/wasm32v1-none/release/lime_amm_pool.wasm");
}
mod fx {
    soroban_sdk::contractimport!(file = "../../target/wasm32v1-none/release/lime_amm_fx_pool.wasm");
}
mod factory {
    soroban_sdk::contractimport!(file = "../../target/wasm32v1-none/release/lime_amm_factory.wasm");
}
const POOL_V4: &[u8] = include_bytes!("../../../releases/lime_amm_pool_v4.wasm");

/// 1 hour at ~5 s per ledger.
const DELAY: u32 = 720;
const T0: u64 = 1_800_000_000;
const PRICE: i128 = 110_000_000_000_000; // EUR/USD 1.10, 14 decimals

struct S {
    e: Env,
    /// The old single admin key (lime-owner).
    owner: Address,
    /// The 2-of-3 multisig account (proposer + canceller).
    multisig: Address,
    /// Single key that can pause pools and cancel timelock operations, nothing else.
    guardian: Address,
    tl: LimeTimelockClient<'static>,
    pool: pool::Client<'static>,
    fx: fx::Client<'static>,
    factory: factory::Client<'static>,
    a: Address,
}

fn zero(e: &Env) -> BytesN<32> {
    BytesN::from_array(e, &[0u8; 32])
}

fn setup() -> S {
    let e = Env::default();
    e.mock_all_auths();
    e.cost_estimate().budget().reset_unlimited();
    e.ledger().set_timestamp(T0);
    let owner = Address::generate(&e);
    let multisig = Address::generate(&e);
    let guardian = Address::generate(&e);
    let tl_id = e.register(
        LimeTimelock,
        (DELAY, vec![&e, multisig.clone()], Vec::<Address>::new(&e), vec![&e, guardian.clone()], None::<Address>),
    );

    let mk = || e.register_stellar_asset_contract_v2(owner.clone()).address();
    let (t1, t2) = (mk(), mk());
    let (a, b) = if t1 < t2 { (t1, t2) } else { (t2, t1) };
    let pool_wasm = e.deployer().upload_contract_wasm(pool::WASM);
    let factory_id = e.register(factory::WASM, (&owner, pool_wasm));
    let factory = factory::Client::new(&e, &factory_id);
    let pool = pool::Client::new(&e, &factory.create_pool(&a, &b, &30));

    let oid = e.register(MockOracle, (&owner, OAsset::Other(Symbol::new(&e, "USD")), 14u32, 300u32));
    let oracle = MockOracleClient::new(&e, &oid);
    for i in (0..7u64).rev() {
        oracle.set_price(&OAsset::Other(Symbol::new(&e, "EUR")), &PRICE, &(T0 - i * 300));
    }
    let fx_id = e.register(
        fx::WASM,
        (
            &owner, &a, &b, &oid,
            fx::Asset::Other(Symbol::new(&e, "EUR")), fx::Asset::Other(Symbol::new(&e, "USD")),
            5u32, 100u32, PRICE / 2, PRICE * 2,
        ),
    );
    let fx = fx::Client::new(&e, &fx_id);

    // LPs in both pools.
    let lp = Address::generate(&e);
    StellarAssetClient::new(&e, &a).mint(&lp, &10_000_000_000);
    StellarAssetClient::new(&e, &b).mint(&lp, &10_000_000_000);
    pool.deposit(&lp, &1_000_000_000, &1_000_000_000, &0, &0);
    fx.deposit(&lp, &1_000_000_000, &1_100_000_000, &0, &0);

    S { tl: LimeTimelockClient::new(&e, &tl_id), e, owner, multisig, guardian, pool, fx, factory, a }
}

fn args1<A: IntoVal<Env, Val>>(e: &Env, a: A) -> Vec<Val> {
    vec![e, a.into_val(e)]
}

fn schedule(s: &S, target: &Address, f: &str, args: &Vec<Val>, salt: &BytesN<32>) -> BytesN<32> {
    s.tl.schedule(target, &Symbol::new(&s.e, f), args, &zero(&s.e), salt, &DELAY, &s.multisig)
}

fn try_execute(s: &S, target: &Address, f: &str, args: &Vec<Val>, salt: &BytesN<32>) -> bool {
    s.tl.try_execute(target, &Symbol::new(&s.e, f), args, &zero(&s.e), salt, &None).is_ok()
}

fn wait(s: &S, ledgers: u32) {
    s.e.ledger().with_mut(|li| li.sequence_number += ledgers);
}

/// Schedule, wait out the delay, execute.
fn run(s: &S, target: &Address, f: &str, args: Vec<Val>) {
    let salt = BytesN::random(&s.e);
    schedule(s, target, f, &args, &salt);
    wait(s, DELAY);
    assert!(try_execute(s, target, f, &args, &salt), "execute {} failed", f);
}

/// What governance.sh does: guardian set by the old key, admin proposed to the timelock,
/// then the timelock accepts through executed operations.
fn hand_over(s: &S) {
    s.pool.set_guardian(&s.owner, &Some(s.guardian.clone()));
    s.fx.set_guardian(&s.owner, &Some(s.guardian.clone()));
    let tl = s.tl.address.clone();
    s.pool.propose_admin(&s.owner, &tl);
    s.fx.propose_admin(&s.owner, &tl);
    s.factory.propose_admin(&s.owner, &tl);
    let salt = BytesN::random(&s.e);
    let targets = [s.pool.address.clone(), s.fx.address.clone(), s.factory.address.clone()];
    for t in targets.iter() {
        schedule(s, t, "accept_admin", &args1(&s.e, &tl), &salt);
    }
    wait(s, DELAY);
    // Open execution needs no signature at all: the timelock is the direct caller, so the
    // targets' `new_admin.require_auth()` passes without any auth entries.
    s.e.set_auths(&[]);
    for t in targets.iter() {
        assert!(try_execute(s, t, "accept_admin", &args1(&s.e, &tl), &salt));
    }
    s.e.mock_all_auths();
}

#[test]
fn constructor_roles() {
    let s = setup();
    assert_eq!(s.tl.get_min_delay(), DELAY);
    assert_eq!(s.tl.version(), VERSION);
    assert!(s.tl.has_role(&s.multisig, &PROPOSER_ROLE).is_some());
    assert!(s.tl.has_role(&s.multisig, &CANCELLER_ROLE).is_some());
    assert!(s.tl.has_role(&s.guardian, &CANCELLER_ROLE).is_some());
    assert!(s.tl.has_role(&s.guardian, &PROPOSER_ROLE).is_none());
    assert_eq!(s.tl.get_admin(), Some(s.tl.address.clone())); // self-administered
}

#[test]
fn timelock_takes_over_and_old_key_is_powerless() {
    let s = setup();
    hand_over(&s);
    let tl = s.tl.address.clone();
    assert_eq!((s.pool.admin(), s.fx.admin(), s.factory.admin()), (tl.clone(), tl.clone(), tl.clone()));

    let hash = s.e.deployer().upload_contract_wasm(POOL_V4);
    let params = s.fx.info().params;
    assert!(s.pool.try_upgrade(&s.owner, &hash).is_err());
    assert!(s.pool.try_pause(&s.owner).is_err());
    assert!(s.fx.try_upgrade(&s.owner, &hash).is_err());
    assert!(s.fx.try_set_params(&s.owner, &params).is_err());
    assert!(s.fx.try_pause(&s.owner).is_err());
    assert!(s.factory.try_set_pool_wasm(&s.owner, &hash).is_err());
    assert!(s.factory.try_upgrade(&s.owner, &hash).is_err());
    // The old key can't even re-propose itself.
    assert!(s.pool.try_propose_admin(&s.owner, &s.owner).is_err());

    // New pools from the factory are born with the timelock as admin.
    let mk = s.e.register_stellar_asset_contract_v2(s.owner.clone()).address();
    let p2 = pool::Client::new(&s.e, &s.factory.create_pool(&s.a, &mk, &30));
    assert_eq!(p2.admin(), tl);
}

#[test]
fn upgrade_and_params_wait_for_the_delay() {
    let s = setup();
    hand_over(&s);
    let tl = s.tl.address.clone();

    // Pool upgrade (to the frozen v4 binary, so the version visibly changes).
    let hash = s.e.deployer().upload_contract_wasm(POOL_V4);
    let args: Vec<Val> = vec![&s.e, tl.into_val(&s.e), hash.into_val(&s.e)];
    let salt = BytesN::random(&s.e);
    let id = schedule(&s, &s.pool.address, "upgrade", &args, &salt);
    assert_eq!(s.tl.get_operation_state(&id), OperationState::Waiting);
    wait(&s, DELAY - 1);
    assert!(!try_execute(&s, &s.pool.address, "upgrade", &args, &salt), "executed before the delay");
    assert_eq!(s.pool.version(), 5);
    wait(&s, 1);
    assert_eq!(s.tl.get_operation_state(&id), OperationState::Ready);
    assert!(try_execute(&s, &s.pool.address, "upgrade", &args, &salt));
    assert_eq!(s.tl.get_operation_state(&id), OperationState::Done);
    assert_eq!(s.pool.version(), 4);
    // An executed operation can't be replayed.
    assert!(!try_execute(&s, &s.pool.address, "upgrade", &args, &salt));

    // LimeFX params and outflow cap through the timelock.
    let mut p = s.fx.info().params;
    p.base_fee_bps = 7;
    run(&s, &s.fx.address, "set_params", vec![&s.e, tl.into_val(&s.e), p.into_val(&s.e)]);
    assert_eq!(s.fx.info().params.base_fee_bps, 7);
    let cap = fx::OutflowCap { cap_bps: 1_000, window: 1_800 };
    run(&s, &s.fx.address, "set_outflow_cap", vec![&s.e, tl.into_val(&s.e), cap.into_val(&s.e)]);
    assert_eq!(s.fx.outflow_cap(), cap);

    // Too short a delay can't be scheduled.
    let r = s.tl.try_schedule(&s.fx.address, &Symbol::new(&s.e, "unpause"), &args1(&s.e, &tl), &zero(&s.e), &zero(&s.e), &(DELAY - 1), &s.multisig);
    assert!(r.is_err());
}

#[test]
fn guardian_pauses_instantly_unpause_is_timelocked() {
    let s = setup();
    hand_over(&s);
    let tl = s.tl.address.clone();
    s.pool.pause(&s.guardian);
    s.fx.pause(&s.guardian);
    assert!(s.pool.paused() && s.fx.paused());
    assert!(s.pool.try_unpause(&s.guardian).is_err());
    assert!(s.fx.try_unpause(&s.guardian).is_err());
    run(&s, &s.pool.address, "unpause", args1(&s.e, &tl));
    run(&s, &s.fx.address, "unpause", args1(&s.e, &tl));
    assert!(!s.pool.paused() && !s.fx.paused());
    // A trade works again on LimeFX.
    let trader = Address::generate(&s.e);
    StellarAssetClient::new(&s.e, &s.a).mint(&trader, &1_000_000);
    s.fx.swap(&trader, &trader, &s.a, &1_000_000, &0);
}

#[test]
fn canceller_vetoes_a_scheduled_upgrade() {
    let s = setup();
    hand_over(&s);
    let tl = s.tl.address.clone();
    let hash = s.e.deployer().upload_contract_wasm(POOL_V4);
    let args: Vec<Val> = vec![&s.e, tl.into_val(&s.e), hash.into_val(&s.e)];
    let salt = BytesN::random(&s.e);
    let id = schedule(&s, &s.fx.address, "upgrade", &args, &salt);
    let version = s.fx.version();
    // Neither the old owner nor a stranger may cancel; the guardian (canceller) can.
    assert!(s.tl.try_cancel(&id, &s.owner).is_err());
    s.tl.cancel(&id, &s.guardian);
    assert_eq!(s.tl.get_operation_state(&id), OperationState::Unset);
    wait(&s, DELAY);
    assert!(!try_execute(&s, &s.fx.address, "upgrade", &args, &salt));
    assert_eq!(s.fx.version(), version); // not upgraded
    // The guardian can't schedule (no proposer role).
    let r = s.tl.try_schedule(&s.fx.address, &Symbol::new(&s.e, "upgrade"), &args, &zero(&s.e), &salt, &DELAY, &s.guardian);
    assert!(r.is_err());
}

/// Changing the timelock's own delay is itself timelocked: schedule `update_delay` on the
/// timelock, wait, then call it directly; `__check_auth` checks and consumes the operation.
#[test]
fn self_administration_of_the_delay() {
    let s = setup();
    let tl = s.tl.address.clone();
    // Not even the multisig can change the delay directly: `update_delay` needs the *timelock's*
    // own auth (only_admin), which only a scheduled, ready operation provides. (With
    // mock_all_auths every auth would pass, so switch mocking off for this check.)
    s.e.set_auths(&[]);
    assert!(s.tl.try_update_delay(&60, &s.multisig).is_err());
    s.e.mock_all_auths();

    let args: Vec<Val> = vec![&s.e, 60u32.into_val(&s.e), tl.into_val(&s.e)];
    let id = schedule(&s, &tl, "update_delay", &args, &zero(&s.e));
    wait(&s, DELAY);
    s.e.try_invoke_contract_check_auth::<stellar_governance::timelock::TimelockError>(
        &tl,
        &BytesN::random(&s.e),
        vec![&s.e, OperationMeta { predecessor: zero(&s.e), salt: zero(&s.e), executor: None }].into_val(&s.e),
        &vec![
            &s.e,
            soroban_sdk::auth::Context::Contract(soroban_sdk::auth::ContractContext {
                contract: tl.clone(),
                fn_name: Symbol::new(&s.e, "update_delay"),
                args: args.clone(),
            }),
        ],
    )
    .unwrap();
    assert_eq!(s.tl.get_operation_state(&id), OperationState::Done);
    // (In a real transaction the host runs that check as part of this call.)
    s.tl.update_delay(&60, &tl);
    assert_eq!(s.tl.get_min_delay(), 60);

    // An unscheduled self-call is rejected by __check_auth.
    let other: Vec<Val> = vec![&s.e, 1u32.into_val(&s.e), tl.into_val(&s.e)];
    let r = s.e.try_invoke_contract_check_auth::<stellar_governance::timelock::TimelockError>(
        &tl,
        &BytesN::random(&s.e),
        vec![&s.e, OperationMeta { predecessor: zero(&s.e), salt: zero(&s.e), executor: None }].into_val(&s.e),
        &vec![
            &s.e,
            soroban_sdk::auth::Context::Contract(soroban_sdk::auth::ContractContext {
                contract: tl.clone(),
                fn_name: Symbol::new(&s.e, "update_delay"),
                args: other,
            }),
        ],
    );
    assert!(r.is_err());
}

/// Review L3: the delay is capped, because a huge delay could only be lowered by an operation
/// that waits for it (permanent lockout). (mock_all_auths stands in for the timelock's own auth.)
#[test]
fn delay_is_capped() {
    let s = setup();
    let tl = s.tl.address.clone();
    assert_eq!(
        s.tl.try_update_delay(&(MAX_DELAY + 1), &tl),
        Err(Ok(soroban_sdk::Error::from_contract_error(TimelockControllerError::DelayTooLong as u32)))
    );
    s.tl.update_delay(&MAX_DELAY, &tl);
    assert_eq!(s.tl.get_min_delay(), MAX_DELAY);
}

#[test]
#[should_panic]
fn constructor_rejects_a_delay_above_the_cap() {
    let e = Env::default();
    let m = Address::generate(&e);
    e.register(LimeTimelock, (MAX_DELAY + 1, vec![&e, m], Vec::<Address>::new(&e), Vec::<Address>::new(&e), None::<Address>));
}
