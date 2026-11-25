// Last-known balances of the connected account, per network + address (browser localStorage):
// shown at once on the next connect or visit while fresh reads are on their way, and updated
// optimistically right after our own swap. Never used to decide a transaction: the chain is.
const memory = new Map();
const keyOf = (chain, user) => `limeswap:bal:${chain.config.passphrase}:${user}`;

function load(chain, user) {
  const k = keyOf(chain, user);
  if (!memory.has(k)) {
    let v = {};
    try { v = JSON.parse(localStorage.getItem(k) ?? "{}") ?? {}; } catch {}
    memory.set(k, v);
  }
  return memory.get(k);
}

/** { balance (bigint | null), trust, kyc } last seen for this token, or undefined. */
export function remembered(chain, user, tokenId) {
  const v = load(chain, user)[tokenId];
  if (!v) return undefined;
  return {
    balance: v.balance === null ? null : BigInt(v.balance),
    trust: v.trust,
    kyc: v.kyc ? { status: v.kyc.status, grant: BigInt(v.kyc.grant) } : null,
  };
}

/** Store what a read (or our own swap) says; fields left undefined keep their old value. */
export function remember(chain, user, tokenId, { balance, trust, kyc } = {}) {
  const all = load(chain, user);
  const old = all[tokenId] ?? { balance: null, trust: "n/a", kyc: null };
  all[tokenId] = {
    balance: balance === undefined ? old.balance : balance === null ? null : String(balance),
    trust: trust ?? old.trust,
    kyc: kyc === undefined ? old.kyc : kyc ? { status: kyc.status, grant: String(kyc.grant) } : null,
  };
  try { localStorage.setItem(keyOf(chain, user), JSON.stringify(all)); } catch { /* full or blocked: memory only */ }
}
