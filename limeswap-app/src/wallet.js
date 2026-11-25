// Browser wallets: Freighter (now "Varial") here, MetaMask (Stellar Snap) in metamask.js. Every
// connect…() returns { kind, address, prompt, sign(txXdr, passphrase) }. Browser-only: smoke.mjs
// never imports this file.
import { getAddress, getNetworkDetails, isAllowed, isConnected, requestAccess, signTransaction } from "@stellar/freighter-api";
export { connectMetaMask, metaMaskStatus } from "./metamask.js";

export async function connectFreighter(passphrase, networkName) {
  if (!(await isConnected()).isConnected) {
    throw new Error("Varial (formerly Freighter) wasn't found. Install the browser extension, switch it to " + networkName + ", then reload.");
  }
  const res = await requestAccess();
  if (res.error) throw new Error(res.error.message || "The wallet refused the connection.");
  const address = res.address;
  await checkNetwork(passphrase, networkName);
  return freighterSigner(address, networkName);
}

/**
 * Page reload: reconnect without a popup when this site is already allowed in Varial and the wallet
 * is on the right network; otherwise null (the Connect button stays). Never asks the user anything.
 */
export async function reconnectFreighter(passphrase, networkName) {
  const attempt = async () => {
    if (!(await isConnected()).isConnected || !(await isAllowed()).isAllowed) return null;
    const [{ address, error }, net] = await Promise.all([getAddress(), getNetworkDetails()]);
    if (error || !address || net.error || net.networkPassphrase !== passphrase) return null;
    return freighterSigner(address, networkName);
  };
  // A sleepy extension shouldn't keep the page guessing: give up after 4 s (Connect still works).
  return Promise.race([attempt().catch(() => null), new Promise((r) => setTimeout(() => r(null), 4_000))]);
}

function freighterSigner(address, networkName) {
  return {
    kind: "freighter",
    address,
    prompt: "Check your wallet: review and confirm the transaction…",
    async sign(txXdr, pass) {
      await checkNetwork(pass, networkName);
      // The wallet remembers site permission per network/account; ask again if it was lost.
      if (!(await isAllowed()).isAllowed) {
        const r = await requestAccess();
        if (r.error) throw new Error(r.error.message || "The wallet refused the connection.");
      }
      // The extension can drop its reply (e.g. its background worker went to sleep while the
      // popup stayed open), and freighter-api then throws or returns nothing. Nothing was sent.
      let signed;
      try {
        signed = await signTransaction(txXdr, { networkPassphrase: pass, address });
      } catch {
        signed = null;
      }
      if (signed?.error) throw new Error(signed.error.message || "Signing was cancelled.");
      if (!signed?.signedTxXdr) {
        throw new Error("The wallet didn't send back a signature (its popup may have timed out). Nothing was submitted; please try again and confirm within a few seconds.");
      }
      return signed.signedTxXdr;
    },
  };
}

// Never ask for a signature while the wallet is on another network: the signature would be
// for the wrong network and the transaction would be rejected (or worse, be valid elsewhere).
async function checkNetwork(passphrase, networkName) {
  const net = await getNetworkDetails();
  if (net.error) throw new Error(net.error.message || "Could not read the wallet's network.");
  if (net.networkPassphrase !== passphrase) {
    throw new Error(`Your wallet is on ${net.network || "another network"}. Switch it to ${networkName} (wallet settings → Network) and try again.`);
  }
}
