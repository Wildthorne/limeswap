// MetaMask via the community "Stellar" Snap (npm:stellar-snap, Paul Fears; listed in MetaMask's Snaps
// Directory, Cure53-audited at 1.0.6). MetaMask's own Stellar support (@metamask/connect-stellar) is
// Mainnet-only as of Nov 2026; swap it in here once it supports Testnet. Research: notes/27 devx log.
// No DOM and no wallet library: unit-tested in Node with a mocked provider (test-metamask.mjs).
import { Keypair, Networks, TransactionBuilder } from "@stellar/stellar-sdk";

export const SNAP_ID = "npm:stellar-snap";
// Pinned: we checked this exact build (its bundled SDK reads our Soroban transactions). A newer
// release only gets in after we look at it.
export const SNAP_VERSION = "1.0.9";
export const INSTALL_URL = "https://metamask.io/download/";
export const SNAP_URL = "https://snaps.metamask.io/snap/npm/stellar-snap/";

/**
 * Find the MetaMask extension. Other wallets (Brave Wallet, Rabby, Coinbase…) also inject
 * `window.ethereum`, some even with `isMetaMask: true`, and none of them run Snaps, so ask for
 * MetaMask by name (EIP-6963) and only fall back to a `window.ethereum` that really is MetaMask.
 */
export async function findMetaMask(win = globalThis.window, waitMs = 150) {
  if (!win) return null;
  const found = [];
  const onAnnounce = (e) => found.push(e.detail);
  win.addEventListener?.("eip6963:announceProvider", onAnnounce);
  win.dispatchEvent?.(new Event("eip6963:requestProvider"));
  await new Promise((r) => setTimeout(r, waitMs));
  win.removeEventListener?.("eip6963:announceProvider", onAnnounce);
  const mm = found.find((d) => /^io\.metamask(\.flask)?$/.test(d?.info?.rdns ?? ""));
  if (mm?.provider) return mm.provider;
  const eth = win.ethereum;
  if (eth?.isMetaMask && !eth.isBraveWallet && !eth.isRabby && !eth.isCoinbaseWallet) return eth;
  return null;
}

/** For the Connect sheet: is MetaMask there, and is the Stellar Snap already added? */
export async function metaMaskStatus(win) {
  const provider = await findMetaMask(win);
  if (!provider) return { installed: false, snap: null };
  try {
    // Don't hold up the Connect sheet if MetaMask is slow to answer (e.g. still starting up).
    const snaps = await Promise.race([
      provider.request({ method: "wallet_getSnaps" }),
      new Promise((r) => setTimeout(() => r(null), 800)),
    ]);
    return { installed: true, snap: snaps?.[SNAP_ID]?.version ?? null };
  } catch {
    return { installed: true, snap: null };
  }
}

/** MetaMask / Snap errors → one plain sentence. */
export function friendlyMetaMaskError(e) {
  const msg = String(e?.message ?? e ?? "");
  if (e?.code === 4001 || /reject|denied|declined|cancel/i.test(msg)) {
    return "You declined in MetaMask. Nothing was signed or sent.";
  }
  if (e?.code === -32002 || /already pending|request.*pending/i.test(msg)) {
    return "MetaMask already has a request waiting. Open MetaMask (its toolbar icon), finish or close that request, then try again.";
  }
  if (/requires?\b.*\bfunded|not funded/i.test(msg)) {
    return "Your MetaMask Stellar account isn't on Testnet yet. Fund it first: Get test tokens → Friendbot.";
  }
  if (/snap.*(not (found|installed)|is not installed)|not.*snap/i.test(msg)) {
    return `The Stellar Snap isn't added to MetaMask. Connect again and approve “Add Stellar” (${SNAP_URL}).`;
  }
  if (/timed? ?out|terminated|unresponsive/i.test(msg)) {
    return "MetaMask stopped waiting (the Stellar Snap timed out). Nothing was submitted; please try again and confirm within a minute.";
  }
  return `MetaMask: ${msg || "something went wrong."}`;
}

const invoke = (provider, method, params) =>
  provider.request({ method: "wallet_invokeSnap", params: { snapId: SNAP_ID, request: { method, params } } });

/**
 * Connect MetaMask's Stellar Snap. Same shape as connectFreighter: { kind, address, prompt, sign }.
 * The Snap has no "current network" of its own (every call says testnet: true or not), so the network
 * guard is ours: Testnet only, and every signature is checked against the Testnet passphrase.
 */
export async function connectMetaMask(passphrase, networkName, { win } = {}) {
  if (passphrase !== Networks.TESTNET) {
    throw new Error(`MetaMask's Stellar Snap only works on Testnet here, and this app is on ${networkName}. Use Varial or the dev signer.`);
  }
  const provider = await findMetaMask(win);
  if (!provider) {
    throw new Error(`MetaMask wasn't found. Install it from ${INSTALL_URL}, reload this page, then connect again. (Brave Wallet and other wallets can't run the Stellar Snap.)`);
  }
  let address;
  try {
    // Installs the Snap on first use (MetaMask shows "Add Stellar"), otherwise just asks for access.
    const res = await provider.request({ method: "wallet_requestSnaps", params: { [SNAP_ID]: { version: SNAP_VERSION } } });
    if (res?.[SNAP_ID]?.error) throw res[SNAP_ID].error;
    address = await invoke(provider, "getAddress", { testnet: true });
  } catch (e) {
    throw new Error(friendlyMetaMaskError(e));
  }
  if (!isAccount(address)) throw new Error("MetaMask's Stellar Snap didn't return an account. Open MetaMask, check the Stellar Snap, then try again.");

  return {
    kind: "metamask",
    address,
    prompt: "Check MetaMask: review and confirm the transaction in the Stellar Snap…",
    async sign(txXdr, pass) {
      if (pass !== Networks.TESTNET) {
        throw new Error(`MetaMask's Stellar Snap only signs for Testnet here; this transaction is for another network. Nothing was signed.`);
      }
      let signed;
      try {
        signed = await invoke(provider, "signTransaction", { transaction: txXdr, testnet: true });
      } catch (e) {
        throw new Error(friendlyMetaMaskError(e));
      }
      if (typeof signed !== "string" || !signed) {
        throw new Error("MetaMask didn't send back a signature (its window may have closed or timed out). Nothing was submitted; please try again.");
      }
      checkSignature(txXdr, signed, pass, address);
      return signed;
    },
  };
}

// SDK 17 hands out plain Uint8Arrays (no Buffer.equals).
const sameBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const isAccount = (a) => typeof a === "string" && /^G[A-Z2-7]{55}$/.test(a);

/**
 * Never pass on what we didn't ask for: the signed transaction must be the one we sent, signed by the
 * connected account for this network's passphrase (a signature for another network wouldn't verify).
 */
export function checkSignature(sentXdr, signedXdr, passphrase, address) {
  let sent, got;
  try {
    sent = TransactionBuilder.fromXDR(sentXdr, passphrase);
    got = TransactionBuilder.fromXDR(signedXdr, passphrase);
  } catch {
    throw new Error("MetaMask sent back something that isn't a Stellar transaction. Nothing was submitted.");
  }
  const hash = sent.hash();
  if (!sameBytes(got.hash(), hash)) {
    throw new Error("MetaMask changed the transaction while signing. Nothing was submitted.");
  }
  const kp = Keypair.fromPublicKey(address);
  // SDK 17 XDR: fields are properties, and opaque typedefs wrap their bytes in `.value`.
  const mine = got.signatures.some((s) => sameBytes(s.hint.value, kp.signatureHint()) && kp.verify(hash, s.signature.value));
  if (!mine) {
    throw new Error(`MetaMask signed with a different Stellar account or network (connected: ${address.slice(0, 6)}…). Switch back to that account in the Stellar Snap, or reconnect.`);
  }
}
