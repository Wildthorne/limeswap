#![no_std]
//! LimeSwap timelock: the admin of the factory, every pool and LimeFX once governance is set up.
//!
//! Adapted from OpenZeppelin's `examples/timelock-controller` (stellar-contracts v0.8.0, MIT),
//! built on `stellar-governance` 0.8 (timelock storage) and `stellar-access` 0.8 (roles).
//!
//! - **Proposer** (our 2-of-3 Stellar multisig account) schedules an operation
//!   `(target, function, args, predecessor, salt)` with `delay >= min_delay` **ledgers**.
//! - After the delay, an **executor** runs it with `execute`; with no executors configured,
//!   anyone may execute a ready operation (it is fully fixed by its hash, so that is safe).
//!   The timelock is the direct caller of the target, so `caller.require_auth()` on the target
//!   (e.g. `pool.upgrade(caller = timelock, ...)`) passes without any signature.
//! - **Canceller** can cancel a pending operation. Proposers are cancellers; extra cancellers
//!   (e.g. a single guardian key) can veto alone but cannot schedule.
//! - **Self-administration**: the timelock is its own role admin. Changing the delay or roles
//!   is itself a scheduled operation targeting the timelock; after the delay you call the admin
//!   function (`update_delay`, `grant_role`, …) directly with the timelock as the operator, and
//!   `__check_auth` below validates the operation and marks it done (Soroban forbids
//!   re-entrancy, so `execute` cannot call the timelock itself).
//!
//! Change vs the OZ example: an extra `cancellers` constructor argument.

use soroban_sdk::{
    auth::{Context, ContractContext, CustomAccountInterface},
    contract, contracterror, contractimpl, contracttype,
    crypto::Hash,
    panic_with_error, symbol_short, Address, BytesN, Env, IntoVal, Symbol, Val, Vec,
};
use stellar_access::access_control::{
    ensure_role, get_role_member_count, grant_role_no_auth, set_admin, AccessControl,
};
use stellar_governance::timelock::{
    cancel_operation, execute_operation, schedule_operation, set_execute_operation,
    set_min_delay as timelock_set_min_delay, Operation, OperationState, Timelock, TimelockError,
};
use stellar_macros::{only_admin, only_role};

#[cfg(test)]
mod test;

pub const VERSION: u32 = 1;

pub const PROPOSER_ROLE: Symbol = symbol_short!("proposer");
pub const EXECUTOR_ROLE: Symbol = symbol_short!("executor");
pub const CANCELLER_ROLE: Symbol = symbol_short!("canceller");

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum TimelockControllerError {
    /// `__check_auth`: one `OperationMeta` per authorized call is required.
    Mismatch = 1,
    /// Delay above MAX_DELAY: lowering it again would itself wait that long (lockout).
    DelayTooLong = 2,
}

/// Upper bound for the minimum delay: 30 days of ~5 s ledgers. A larger delay can only be
/// lowered by an operation that waits for it, so an unbounded value could lock the timelock.
pub const MAX_DELAY: u32 = 30 * 17_280;

fn checked_delay(e: &Env, delay: u32) -> u32 {
    if delay > MAX_DELAY {
        soroban_sdk::panic_with_error!(e, TimelockControllerError::DelayTooLong);
    }
    delay
}

/// Signature for self-administration: the `predecessor` / `salt` the operation was scheduled
/// with, and the executor (required when executors are configured).
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct OperationMeta {
    pub predecessor: BytesN<32>,
    pub salt: BytesN<32>,
    pub executor: Option<Address>,
}

#[contract]
pub struct LimeTimelock;

#[contractimpl]
impl CustomAccountInterface for LimeTimelock {
    type Error = TimelockError;
    type Signature = Vec<OperationMeta>;

    /// Only for calls the timelock authorizes on *itself* (self-administration): each must be a
    /// scheduled, ready operation; it is marked done here.
    fn __check_auth(
        e: Env,
        _signature_payload: Hash<32>,
        context_meta: Vec<OperationMeta>,
        auth_contexts: Vec<Context>,
    ) -> Result<(), Self::Error> {
        if auth_contexts.len() != context_meta.len() {
            panic_with_error!(&e, TimelockControllerError::Mismatch);
        }
        for (context, meta) in auth_contexts.iter().zip(context_meta) {
            match context {
                Context::Contract(ContractContext { contract, fn_name, args }) => {
                    if contract != e.current_contract_address() {
                        panic_with_error!(&e, TimelockError::Unauthorized)
                    }
                    if get_role_member_count(&e, &EXECUTOR_ROLE) != 0 {
                        let executor = meta
                            .executor
                            .clone()
                            .unwrap_or_else(|| panic_with_error!(&e, TimelockError::Unauthorized));
                        ensure_role(&e, &EXECUTOR_ROLE, &executor);
                        executor.require_auth_for_args(
                            (
                                Symbol::new(&e, "execute_op"),
                                contract.clone(),
                                fn_name.clone(),
                                args.clone(),
                                meta.predecessor.clone(),
                                meta.salt.clone(),
                            )
                                .into_val(&e),
                        );
                    }
                    let op = Operation {
                        target: contract,
                        function: fn_name,
                        args,
                        predecessor: meta.predecessor,
                        salt: meta.salt,
                    };
                    set_execute_operation(&e, &op);
                }
                _ => panic_with_error!(&e, TimelockError::Unauthorized),
            }
        }
        Ok(())
    }
}

#[contractimpl]
impl LimeTimelock {
    /// `min_delay` in ledgers (~5 s each). `admin` = None makes the timelock its own admin (the
    /// production setting); an external admin is only for initial setup and should renounce.
    pub fn __constructor(
        e: &Env,
        min_delay: u32,
        proposers: Vec<Address>,
        executors: Vec<Address>,
        cancellers: Vec<Address>,
        admin: Option<Address>,
    ) {
        let admin_addr = admin.unwrap_or_else(|| e.current_contract_address());
        set_admin(e, &admin_addr);
        for p in proposers.iter() {
            grant_role_no_auth(e, &p, &PROPOSER_ROLE, &admin_addr);
            grant_role_no_auth(e, &p, &CANCELLER_ROLE, &admin_addr);
        }
        for x in executors.iter() {
            grant_role_no_auth(e, &x, &EXECUTOR_ROLE, &admin_addr);
        }
        for c in cancellers.iter() {
            if !proposers.contains(&c) {
                grant_role_no_auth(e, &c, &CANCELLER_ROLE, &admin_addr);
            }
        }
        timelock_set_min_delay(e, checked_delay(e, min_delay));
    }

    pub fn version(_e: &Env) -> u32 {
        VERSION
    }
}

#[contractimpl(contracttrait)]
impl Timelock for LimeTimelock {
    #[allow(clippy::too_many_arguments)]
    #[only_role(proposer, "proposer")]
    fn schedule(
        e: &Env,
        target: Address,
        function: Symbol,
        args: Vec<Val>,
        predecessor: BytesN<32>,
        salt: BytesN<32>,
        delay: u32,
        proposer: Address,
    ) -> BytesN<32> {
        schedule_operation(e, &Operation { target, function, args, predecessor, salt }, delay)
    }

    fn execute(
        e: &Env,
        target: Address,
        function: Symbol,
        args: Vec<Val>,
        predecessor: BytesN<32>,
        salt: BytesN<32>,
        executor: Option<Address>,
    ) -> Val {
        if get_role_member_count(e, &EXECUTOR_ROLE) != 0 {
            let executor = executor.unwrap_or_else(|| panic_with_error!(e, TimelockError::Unauthorized));
            ensure_role(e, &EXECUTOR_ROLE, &executor);
            executor.require_auth();
        }
        execute_operation(e, &Operation { target, function, args, predecessor, salt })
    }

    #[only_role(canceller, "canceller")]
    fn cancel(e: &Env, operation_id: BytesN<32>, canceller: Address) {
        cancel_operation(e, &operation_id);
    }

    #[only_admin]
    fn update_delay(e: &Env, new_delay: u32, _operator: Address) {
        timelock_set_min_delay(e, checked_delay(e, new_delay));
    }
}

#[contractimpl(contracttrait)]
impl AccessControl for LimeTimelock {}
