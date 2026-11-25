// Turn Soroban errors into sentences a person can act on.
//
// A failed simulation gives us one string: "HostError: Error(Contract, #14)" followed by a
// diagnostic event log. The top line only has the number, not *which* contract raised it — and
// #4 means "deadline passed" in one of our contracts and "unauthorized" in a token. The event
// log does say who: the oldest "[error, Error(Contract, #N)]" event is where the error started
// (later ones are callers passing it up). So we take that one and look the number up in the
// table for that kind of contract.

const POOL = {
  1: "Only the pool admin can do this.",
  2: "Enter an amount above zero.",
  3: "The pool doesn't have enough liquidity for this (or the amount is too small to mint any LP shares).",
  4: "You would receive less than your minimum. The price moved since the quote: refresh, or allow more slippage.",
  5: "The pool ratio moved: you'd deposit less of the first token than your minimum. Refresh and try again.",
  6: "The pool ratio moved: you'd deposit less of the second token than your minimum. Refresh and try again.",
  7: "The pool's safety check (x·y = k) failed: the trade would have taken value out of the pool.",
  8: "That token is not part of this pool.",
  9: "That fee tier doesn't exist (only 0.05%, 0.3% and 1%).",
  10: "You don't have that many LP shares.",
  11: "Not enough trading history yet for an average (TWAP) price.",
  12: "Both sides of the swap are the same token.",
  13: "A number got too large for the contract's math.",
  14: "Compliance pool: the issuer of a regulated token here hasn't authorized your account (no approved trustline, or you are frozen), so you can't hold LP shares.",
  15: "Only the token's issuer can do this.",
  16: "Compliance mode isn't on for this token.",
  17: "LP shares can't be sent to the pool itself (they would be locked forever).",
};

const ROUTER = {
  1: "The swap's deadline (5 minutes) passed before it reached the network. Try again.",
  2: "That route is not valid (needs at least two tokens and one fee per hop).",
  3: "No LimeSwap pool exists for one hop of this route.",
  4: "You would receive less than your minimum. The price moved since the quote: refresh, or allow more slippage.",
};

const FACTORY = {
  1: "Only the factory admin can do this.",
  2: "A pool needs two different tokens.",
  3: "Fee tier not allowed (only 0.05%, 0.3% and 1%).",
  4: "That pool already exists.",
};

const FX = {
  1: "Only the LimeFX admin can do this.",
  2: "Enter an amount above zero.",
  3: "LimeFX doesn't have enough liquidity for this (or the amount is too small to mint LP shares).",
  4: "You would receive less than your minimum. The oracle or pool moved since the quote: refresh, or allow more slippage.",
  5: "The pool ratio moved: you'd deposit less of the first token than your minimum. Refresh and try again.",
  6: "The pool ratio moved: you'd deposit less of the second token than your minimum. Refresh and try again.",
  7: "That token is not part of LimeFX.",
  8: "Invalid fee setting.",
  9: "You don't have that many LP shares.",
  10: "Both sides of the swap are the same token.",
  11: "A number got too large for the contract's math.",
  12: "The two tokens use different decimals, which LimeFX can't price.",
  13: "The oracle has no price for one of the currencies, so LimeFX won't trade.",
  14: "The oracle price is too old (stale). LimeFX refuses to trade on an old price, because the real rate may have moved. On local, start oracle-keeper.mjs; on Testnet wait for Reflector's next update (every 5 min).",
  15: "Circuit breaker: the oracle price jumped too far from its recent average, so LimeFX pauses trading until it settles.",
  16: "Invalid LimeFX parameters.",
  17: "Both sides use the same oracle asset.",
  18: "The oracle price is outside LimeFX's hard safety band, so trading is blocked (protects LPs from a broken or manipulated oracle).",
  19: "The amp setting can only change once a day.",
  20: "The amp setting can change by at most ×2 or ÷2 at a time.",
  21: "The oracle changed its number of decimals, so LimeFX stopped trusting it.",
  22: "The oracle price has a timestamp in the future, which LimeFX refuses.",
  23: "The two oracle prices are from different moments, so the cross rate isn't reliable.",
};

const ORACLE = {
  1: "Only the oracle admin can post prices.",
  2: "Price must be above zero.",
  3: "Oracle timestamps can't go backwards.",
  4: "The base currency's price is fixed at 1.",
};

// Built-in Stellar Asset Contract (classic assets like XLM, LIME, LFUND, LEUR, LUSD).
const SAC = {
  2: "This token doesn't support that operation.",
  4: "Not authorized by the token.",
  5: "Signature/authorization check failed.",
  6: "That account doesn't exist on this network yet (fund it first).",
  7: "That operation needs a classic Stellar account.",
  8: "Amounts can't be negative.",
  9: "Allowance too low.",
  10: "Not enough balance (or the amount would push a balance outside what the account can hold).",
  11: "The issuer has frozen (deauthorized) this trustline, so the account can't send or receive this token.",
  12: "A number got too large.",
  13: "No trustline: the account must add a trustline for this asset before it can hold it (in Freighter: Manage assets → Add).",
  14: "Not enough XLM left for the account's minimum reserve.",
  15: "The account has too many trustlines/offers.",
};

// OpenZeppelin building blocks (LP share token, contract LIME, Pausable).
const OZ = {
  100: "Not enough balance.",
  101: "Allowance too low.",
  1000: "This pool is paused by its admin: swaps and deposits are switched off (withdrawals still work).",
  1001: "This pool is not paused.",
};

const FAUCET = {
  1: "Only the faucet admin can do this.",
  2: "You already claimed test tokens today. The faucet pays each address once every 24 hours.",
  3: "The faucet has run dry for one of the tokens. It gets refilled; try again later.",
  4: "Invalid faucet settings.",
};

// Demo KYC desk (lime-amm/contracts/kyc).
const KYC = {
  1: "Your account is already verified for this token.",
  2: "The token's issuer froze your account, so the demo KYC can't approve it. Only the issuer can lift that.",
  3: "The account has no trustline for this token yet.",
  4: "Invalid amount.",
};

const TABLES = { kyc: KYC, faucet: FAUCET, pool: POOL, router: ROUTER, factory: FACTORY, fx: FX, oracle: ORACLE, sac: SAC, token: {} };
const LABEL = { kyc: "KYC desk", faucet: "faucet", pool: "LimeSwap pool", router: "router", factory: "factory", fx: "LimeFX", oracle: "oracle", sac: "token", token: "token" };

const HOST = {
  "Auth, InvalidAction": "A required signature is missing (authorization failed).",
  "Budget, ExceededLimit": "The transaction needs more CPU or memory than the network allows.",
  "Storage, ExceededLimit": "The transaction reads or writes more data than the network allows.",
  "Storage, MissingValue": "A contract or its data is missing (archived, or not deployed on this network).",
  "Value, InvalidInput": "One of the inputs is invalid.",
  "WasmVm, InvalidAction": "The contract stopped unexpectedly (a bug or an unhandled case).",
};

/**
 * @param {string} raw  simulation error string (or Error.message)
 * @param {(id: string) => string|undefined} kindOf  "pool" | "fx" | "router" | ... for a contract ID
 * @param {string} [calledId] contract we called (used when the log has no contract IDs)
 */
export function explainError(raw, kindOf, calledId) {
  const text = String(raw ?? "");
  const hits = [...text.matchAll(/contract:(C[A-Z2-7]{55}), topics:\[error, Error\(Contract, #(\d+)\)\]/g)];
  let contractId = calledId, code;
  if (hits.length) {
    const origin = hits[hits.length - 1]; // newest-first log: the last match is where it started
    contractId = origin[1];
    code = Number(origin[2]);
  } else {
    const m = text.match(/Error\(Contract, #(\d+)\)/);
    if (m) code = Number(m[1]);
  }
  if (code !== undefined) {
    const kind = kindOf(contractId) ?? "unknown";
    const msg = TABLES[kind]?.[code] ?? OZ[code];
    const who = LABEL[kind] ?? "contract";
    return msg ? `${msg} (${who} error #${code})` : `The ${who} rejected this (error #${code}).`;
  }
  for (const [k, msg] of Object.entries(HOST)) if (text.includes(`Error(${k})`)) return msg;
  if (/txBadSeq/.test(text)) return "Your account's sequence number changed (another transaction went first). Try again.";
  if (/txInsufficientBalance|txInsufficientFee/.test(text)) return "Not enough XLM to pay the network fee.";
  return text.split("\n")[0].slice(0, 300) || "Unknown error";
}
