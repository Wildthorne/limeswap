// Mock KYC (Testnet demo): the "Verify me" callout for a regulated token whose issuer runs a KYC
// desk contract (lime-amm/kyc.sh). Swap and Liquidity show it where approval is what's missing and
// run verify() from its button.
import { kycDesk, kycGrant, kycStatus, kycVerifyCall } from "../dex.js";
import { esc, fmtAmount } from "../format.js";
import { callout, runTx, tip } from "./dom.js";

const grants = new Map(); // token id -> starter grant (it rarely changes)

/** { status, grant } of `user` at `token`'s KYC desk, or null when the token has none. */
export async function loadKyc(app, token, user) {
  if (!kycDesk(app.chain, token) || !user) return null;
  if (!grants.has(token.id)) grants.set(token.id, kycGrant(app.chain, token)); // read once, alongside the status
  const [grant, status] = await Promise.all([grants.get(token.id), kycStatus(app.chain, token, user)]);
  return status ? { status, grant } : null;
}

/** Callout HTML when the desk is the way to get approved (or why it can't help), else null.
 * `button: false` leaves out its "Verify me" button when the page's main button runs verify instead. */
export function kycCallout(token, trust, kyc, { button = true } = {}) {
  if (!kyc || trust === "authorized" || kyc.status === "verified") return null;
  const s = esc(token.symbol);
  if (kyc.status === "revoked") {
    return callout("bad", `${s}'s issuer froze your account, so you can't hold ${s}. Only the issuer can lift that. ${tip("The demo's self-service check is closed to accounts the issuer froze, like a sanctions hit in real life.")}`);
  }
  const grant = kyc.grant > 0n ? `${fmtAmount(kyc.grant, token.decimals)} ${token.symbol}` : "";
  return callout("info", `${s} is a regulated token: its issuer must approve your account first.${grant ? ` Verify to get approved and receive ${esc(grant)} to try.` : ""}
    ${button ? `<br><button class="btn btn-lime btn-sm" data-kyc="${esc(token.id)}">Verify me (demo KYC)</button>` : ""}
    ${tip(`Testnet demo: anyone passes. One signature adds the ${token.symbol} trustline and the issuer's contract approves it${grant ? ` and sends you ${grant}` : ""}. In real life a KYC provider checks who you are first (SEP-12), or the issuer co-signs every transfer (SEP-8). The issuer can still freeze you.`)}`);
}

/** Run `verify` for `token`. Resolves true once it landed. */
export function verify(app, button, statusEl, token) {
  return runTx(app, button, statusEl, kycVerifyCall(app.chain, token, app.signer.address),
    (granted) => `Your account is approved for ${token.symbol}${BigInt(granted ?? 0) > 0n ? `, and ${fmtAmount(BigInt(granted), token.decimals)} ${token.symbol} is in your wallet` : ""}.`,
    { kicker: "Verified" });
}
