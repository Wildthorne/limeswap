// Unit tests for the MetaMask (Stellar Snap) adapter, src/metamask.js, with a mocked MetaMask:
// a fake window that answers EIP-6963 discovery, and a provider whose wallet_requestSnaps /
// wallet_invokeSnap behave like the real Snap (signing with a throwaway key) or fail like it does.
// No browser, no extension, no network. Run: npm run test:wallet
import assert from "node:assert/strict";
import { Account, Keypair, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { SNAP_ID, SNAP_VERSION, checkSignature, connectMetaMask, findMetaMask, metaMaskStatus } from "./src/metamask.js";

const LOCAL = "Standalone Network ; February 2017";
const CONTRACT = "CA77T2PP4QMFD6SKF5T5B3WVG2RLSADVIMIM3WJQHOGRMQ5MQWNNHMTQ"; // router v2 (any C… works)

/** A Soroban contract call like the ones chain.invoke asks wallets to sign. */
function sorobanTx(source, passphrase = Networks.TESTNET, fee = "100") {
  return new TransactionBuilder(new Account(source, "1"), { fee, networkPassphrase: passphrase })
    .addOperation(Operation.invokeContractFunction({ contract: CONTRACT, function: "swap_exact_in", args: [] }))
    .setTimeout(300)
    .build()
    .toXDR();
}

/**
 * Mock MetaMask. `snap` overrides how the Snap answers; `calls` records every request.
 * Default behaviour = the real Snap's: getAddress → its G… address, signTransaction → parse with the
 * passphrase for `testnet`, sign, return the XDR string.
 */
function mockMetaMask({ key = Keypair.random(), snap = {}, installed = {}, getSnaps } = {}) {
  const calls = [];
  const provider = {
    isMetaMask: true,
    async request({ method, params }) {
      calls.push({ method, params });
      if (method === "wallet_getSnaps") return getSnaps ? getSnaps() : installed;
      if (method === "wallet_requestSnaps") {
        if (snap.requestSnaps) return snap.requestSnaps(params);
        return { [SNAP_ID]: { version: SNAP_VERSION, id: SNAP_ID, enabled: true, blocked: false } };
      }
      if (method === "wallet_invokeSnap") {
        assert.equal(params.snapId, SNAP_ID);
        const { method: m, params: p } = params.request;
        if (snap[m]) return snap[m](p, key);
        if (m === "getAddress") return key.publicKey();
        if (m === "signTransaction") {
          const tx = TransactionBuilder.fromXDR(p.transaction, p.testnet ? Networks.TESTNET : Networks.PUBLIC);
          tx.sign(key);
          return tx.toXDR();
        }
        throw new Error("Method not found.");
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  return { provider, calls, key };
}

/** A fake browser window: EventTarget + EIP-6963 announcers + optional window.ethereum. */
function fakeWindow({ announce = [], ethereum } = {}) {
  const win = new EventTarget();
  win.ethereum = ethereum;
  win.addEventListener("eip6963:requestProvider", () => {
    for (const detail of announce) win.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail }));
  });
  return win;
}
const announced = (provider, rdns = "io.metamask", name = "MetaMask") => ({ info: { uuid: crypto.randomUUID(), name, icon: "", rdns }, provider });
const rpcError = (code, message) => Object.assign(new Error(message), { code });

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ---------- Discovery ----------
test("finds MetaMask through EIP-6963 even when another wallet owns window.ethereum", async () => {
  const mm = mockMetaMask();
  const brave = { isMetaMask: true, isBraveWallet: true, request: async () => assert.fail("used Brave Wallet") };
  const win = fakeWindow({ announce: [announced(brave, "com.brave.wallet", "Brave Wallet"), announced(mm.provider)], ethereum: brave });
  assert.equal(await findMetaMask(win, 5), mm.provider);
});
test("ignores Brave Wallet pretending to be MetaMask (no EIP-6963 MetaMask)", async () => {
  const win = fakeWindow({ ethereum: { isMetaMask: true, isBraveWallet: true, request: async () => {} } });
  assert.equal(await findMetaMask(win, 5), null);
  await assert.rejects(connectMetaMask(Networks.TESTNET, "Testnet", { win }), /MetaMask wasn't found.*Brave Wallet/);
});
test("falls back to a genuine window.ethereum MetaMask without EIP-6963", async () => {
  const mm = mockMetaMask();
  assert.equal(await findMetaMask(fakeWindow({ ethereum: mm.provider }), 5), mm.provider);
});
test("Flask counts as MetaMask", async () => {
  const mm = mockMetaMask();
  assert.equal(await findMetaMask(fakeWindow({ announce: [announced(mm.provider, "io.metamask.flask", "MetaMask Flask")] }), 5), mm.provider);
});
test("no window at all (Node, SSR) → not found", async () => {
  assert.equal(await findMetaMask(undefined), null);
});

// ---------- Connect sheet status ----------
test("status: not installed / installed without Snap / Snap added", async () => {
  assert.deepEqual(await metaMaskStatus(fakeWindow()), { installed: false, snap: null });
  const bare = mockMetaMask();
  assert.deepEqual(await metaMaskStatus(fakeWindow({ announce: [announced(bare.provider)] })), { installed: true, snap: null });
  const ready = mockMetaMask({ installed: { [SNAP_ID]: { version: "1.0.9" } } });
  assert.deepEqual(await metaMaskStatus(fakeWindow({ announce: [announced(ready.provider)] })), { installed: true, snap: "1.0.9" });
});
test("status doesn't hang when MetaMask never answers wallet_getSnaps", async () => {
  const slow = mockMetaMask({ getSnaps: () => new Promise(() => {}) });
  const t0 = Date.now();
  assert.deepEqual(await metaMaskStatus(fakeWindow({ announce: [announced(slow.provider)] })), { installed: true, snap: null });
  assert.ok(Date.now() - t0 < 2000);
});

// ---------- Connect ----------
test("connect: installs/asks for the pinned Snap, then reads the Testnet address", async () => {
  const mm = mockMetaMask();
  const w = await connectMetaMask(Networks.TESTNET, "Testnet", { win: fakeWindow({ announce: [announced(mm.provider)] }) });
  assert.equal(w.kind, "metamask");
  assert.equal(w.address, mm.key.publicKey());
  assert.match(w.prompt, /MetaMask/);
  assert.equal(typeof w.sign, "function");
  assert.deepEqual(mm.calls[0], { method: "wallet_requestSnaps", params: { [SNAP_ID]: { version: SNAP_VERSION } } });
  assert.deepEqual(mm.calls[1].params.request, { method: "getAddress", params: { testnet: true } });
});
test("connect refuses any network but Testnet, before touching MetaMask", async () => {
  const mm = mockMetaMask();
  const win = fakeWindow({ announce: [announced(mm.provider)] });
  await assert.rejects(connectMetaMask(LOCAL, "Local", { win }), /only works on Testnet.*Local/);
  await assert.rejects(connectMetaMask(Networks.PUBLIC, "Mainnet", { win }), /only works on Testnet/);
  assert.equal(mm.calls.length, 0);
});
test("connect: user closes the Add Snap / connect request (4001)", async () => {
  const mm = mockMetaMask({ snap: { requestSnaps: () => { throw rpcError(4001, "User rejected the request."); } } });
  await assert.rejects(connectMetaMask(Networks.TESTNET, "Testnet", { win: fakeWindow({ announce: [announced(mm.provider)] }) }), /You declined in MetaMask/);
});
test("connect: another MetaMask request already open (-32002)", async () => {
  const mm = mockMetaMask({ snap: { requestSnaps: () => { throw rpcError(-32002, "Request of type 'wallet_requestSnaps' already pending for origin http://localhost:5212. Please wait."); } } });
  await assert.rejects(connectMetaMask(Networks.TESTNET, "Testnet", { win: fakeWindow({ announce: [announced(mm.provider)] }) }), /already has a request waiting/);
});
test("connect: Snap install fails inside the requestSnaps result", async () => {
  const mm = mockMetaMask({ snap: { requestSnaps: () => ({ [SNAP_ID]: { error: { message: "Snap \"npm:stellar-snap\" is not installed." } } }) } });
  await assert.rejects(connectMetaMask(Networks.TESTNET, "Testnet", { win: fakeWindow({ announce: [announced(mm.provider)] }) }), /Stellar Snap isn't added/);
});
test("connect: Snap returns no address", async () => {
  const mm = mockMetaMask({ snap: { getAddress: () => undefined } });
  await assert.rejects(connectMetaMask(Networks.TESTNET, "Testnet", { win: fakeWindow({ announce: [announced(mm.provider)] }) }), /didn't return an account/);
});

// ---------- Sign ----------
async function connected(opts) {
  const mm = mockMetaMask(opts);
  const w = await connectMetaMask(Networks.TESTNET, "Testnet", { win: fakeWindow({ announce: [announced(mm.provider)] }) });
  return { mm, w };
}
test("sign: Soroban call signed for Testnet by the connected account", async () => {
  const { mm, w } = await connected();
  const xdr = sorobanTx(w.address);
  const signed = await w.sign(xdr, Networks.TESTNET);
  const tx = TransactionBuilder.fromXDR(signed, Networks.TESTNET);
  assert.equal(tx.signatures.length, 1);
  assert.ok(mm.key.verify(tx.hash(), tx.signatures[0].signature.value));
  assert.deepEqual(mm.calls.at(-1).params.request, { method: "signTransaction", params: { transaction: xdr, testnet: true } });
});
test("sign refuses another network's transaction, without asking MetaMask", async () => {
  const { mm, w } = await connected();
  const n = mm.calls.length;
  await assert.rejects(w.sign(sorobanTx(w.address, Networks.PUBLIC), Networks.PUBLIC), /only signs for Testnet/);
  await assert.rejects(w.sign(sorobanTx(w.address, LOCAL), LOCAL), /only signs for Testnet/);
  assert.equal(mm.calls.length, n);
});
test("sign: user rejects in the Snap dialog", async () => {
  const { w } = await connected({ snap: { signTransaction: () => { throw rpcError(-32603, "user rejected request"); } } });
  await assert.rejects(w.sign(sorobanTx(w.address), Networks.TESTNET), /You declined in MetaMask\. Nothing was signed/);
});
test("sign: account not funded on Testnet yet", async () => {
  const { w } = await connected({ snap: { signTransaction: () => { throw rpcError(-32603, "Method Requires Account to be funded"); } } });
  await assert.rejects(w.sign(sorobanTx(w.address), Networks.TESTNET), /isn't on Testnet yet.*Friendbot/);
});
test("sign: Snap timed out / was terminated", async () => {
  const { w } = await connected({ snap: { signTransaction: () => { throw rpcError(-32603, "The snap \"npm:stellar-snap\" has been terminated during execution."); } } });
  await assert.rejects(w.sign(sorobanTx(w.address), Networks.TESTNET), /timed out\)\. Nothing was submitted/);
  const { w: w2 } = await connected({ snap: { signTransaction: () => { throw rpcError(-32603, "Request timed out"); } } });
  await assert.rejects(w2.sign(sorobanTx(w2.address), Networks.TESTNET), /stopped waiting/);
});
test("sign: lost reply (Snap returns nothing)", async () => {
  const { w } = await connected({ snap: { signTransaction: () => null } });
  await assert.rejects(w.sign(sorobanTx(w.address), Networks.TESTNET), /didn't send back a signature.*Nothing was submitted/);
});
test("sign: signature made for Mainnet is caught", async () => {
  const { w } = await connected({ snap: { signTransaction: (p, key) => {
    const tx = TransactionBuilder.fromXDR(p.transaction, Networks.PUBLIC); // ignores testnet: true
    tx.sign(key);
    return tx.toXDR();
  } } });
  await assert.rejects(w.sign(sorobanTx(w.address), Networks.TESTNET), /different Stellar account or network/);
});
test("sign: signed by another Snap account is caught", async () => {
  const other = Keypair.random();
  const { w } = await connected({ snap: { signTransaction: (p) => {
    const tx = TransactionBuilder.fromXDR(p.transaction, Networks.TESTNET);
    tx.sign(other);
    return tx.toXDR();
  } } });
  await assert.rejects(w.sign(sorobanTx(w.address), Networks.TESTNET), /different Stellar account/);
});
test("sign: a transaction changed while signing is refused", async () => {
  const { w } = await connected({ snap: { signTransaction: (p, key) => {
    const tx = TransactionBuilder.fromXDR(sorobanTx(key.publicKey(), Networks.TESTNET, "999999"), Networks.TESTNET);
    tx.sign(key);
    return tx.toXDR();
  } } });
  await assert.rejects(w.sign(sorobanTx(w.address), Networks.TESTNET), /changed the transaction/);
});
test("sign: garbage back from the Snap", async () => {
  const { w } = await connected({ snap: { signTransaction: () => "not-xdr" } });
  await assert.rejects(w.sign(sorobanTx(w.address), Networks.TESTNET), /isn't a Stellar transaction/);
});
test("checkSignature accepts a valid signature among several", () => {
  const me = Keypair.random();
  const xdr = sorobanTx(me.publicKey());
  const tx = TransactionBuilder.fromXDR(xdr, Networks.TESTNET);
  tx.sign(Keypair.random());
  tx.sign(me);
  checkSignature(xdr, tx.toXDR(), Networks.TESTNET, me.publicKey());
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL ${name}\n       ${e.message.split("\n").join("\n       ")}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
