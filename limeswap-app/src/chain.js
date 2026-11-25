// Talking to the network. No DOM here: the web app and the Node smoke test share this file.
//
// Reads  = simulate a transaction (free, no signature, nothing is submitted).
// Writes = simulate -> assemble (adds fees, footprint, auth) -> sign -> send -> poll.
import {
  Account, Address, Asset, BASE_FEE, Contract, Keypair, Operation, TransactionBuilder,
  nativeToScVal, rpc, scValToNative, xdr,
} from "@stellar/stellar-sdk";
import { explainError } from "./errors.js";

// Any valid G-address works as the "source" of a read-only simulation.
const READ_ONLY_SOURCE = "GAAZ3EERTHK3DAWIHLYEJ4ZBWQXKDEIGP7LBO4LMVUZJM5INGLLZ7UM2";

// Faster RPC endpoints tried before the network's default one (deployed.<net>.json rpcUrl, kept as
// the fallback). Nov 9, 2026 on Testnet: SDF's public RPC took 1–9 s per call, Gateway.fm 0.05–0.5 s,
// same RPC version, same 7-day history, same latest ledger; both listed on developers.stellar.org.
// Every browser endpoint must also be in public/_headers (CSP connect-src).
const FAST_RPC = {
  testnet: ["https://soroban-rpc.testnet.stellar.gateway.fm"],
};

const FAST_RPC_URLS = new Set(Object.values(FAST_RPC).flat());

/** Build the app config from projects/deployed.<net>.json + projects/lime-amm/deployed.<net>.json. */
export function makeConfig(network, app, amm) {
  if (!app || !amm) throw new Error(`Missing deployed.${network}.json (run projects/setup.sh ${network})`);
  return {
    network,
    rpcUrl: app.rpcUrl,
    // In order of preference. LIMESWAP_RPC=default (Node scripts) skips the fast ones: tests the fallback.
    rpcUrls: [...new Set([...(globalThis.process?.env?.LIMESWAP_RPC === "default" ? [] : FAST_RPC[network] ?? []), app.rpcUrl])],
    passphrase: app.passphrase,
    explorer: app.explorer, // null on local
    factory: amm.factory,
    router: amm.router,
    tokens: amm.tokens, // { xlm, limeContract, limeClassic, lfund, leur, lusd }
    fx: amm.fx, // { pool, oracle, comparisonPool }
    faucet: amm.faucet ?? null, // demo faucet (claim test tokens once a day)
    kyc: amm.kyc ?? {}, // mock KYC desks of regulated tokens, by token key (Testnet demo, lime-amm/kyc.sh)
    // Pool IDs known at deploy time: read on a cold start in parallel with the factory's list.
    poolHints: (amm.pools ?? []).map((p) => p.id),
    poolNotes: Object.fromEntries((amm.pools ?? []).filter((p) => p.note).map((p) => [p.id, p.note])), // why a pool exists, if special
    // Friendbot gives new accounts test XLM: Stellar's public one on Testnet, the container's on local.
    friendbot: network === "testnet" ? "https://friendbot.stellar.org"
      : network === "local" ? app.rpcUrl.replace(/\/rpc$/, "/friendbot") : null,
  };
}

// ---------- ScVal helpers ----------
export const sv = {
  addr: (a) => new Address(a).toScVal(),
  i128: (n) => nativeToScVal(BigInt(n), { type: "i128" }),
  u32: (n) => nativeToScVal(Number(n), { type: "u32" }),
  u64: (n) => nativeToScVal(BigInt(n), { type: "u64" }),
  addrs: (list) => xdr.ScVal.scvVec(list.map((a) => new Address(a).toScVal())),
  u32s: (list) => xdr.ScVal.scvVec(list.map((n) => nativeToScVal(Number(n), { type: "u32" }))),
  // Router v2 route hops: LimeSwap pool by fee tier, or LimeFX by address (Rust enum `Hop`).
  hops: (pools) => xdr.ScVal.scvVec(pools.map((p) => xdr.ScVal.scvVec(p.type === "fx"
    ? [xdr.ScVal.scvSymbol("Fx"), new Address(p.id).toScVal()]
    : [xdr.ScVal.scvSymbol("Pool"), nativeToScVal(Number(p.feeBps), { type: "u32" })]))),
  /** SEP-40 Asset enum: ["Other","EUR"] -> vec[Symbol("Other"), Symbol("EUR")] (Stellar(addr) also works). */
  asset: ([tag, val]) =>
    xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(tag), tag === "Stellar" ? new Address(val).toScVal() : xdr.ScVal.scvSymbol(val)]),
};

export class ChainError extends Error {
  constructor(message, raw) {
    super(message);
    this.raw = raw;
  }
}

// ---------- RPC failover ----------
// Per-call time limits before trying the next endpoint (ms); 0 = none. getEvents scans many ledgers.
// pollTransaction waits for inclusion itself (NOT_FOUND = keep polling), so it gets no limit and only
// moves to the next endpoint if one errors: a landed transaction never looks lost because one node
// went away. sendTransaction is never repeated elsewhere (a second submission of the same
// transaction would come back as a confusing duplicate).
const RPC_TIMEOUT_MS = { default: 5_000, getEvents: 20_000, pollTransaction: 0 };
const NO_FAILOVER = new Set(["sendTransaction"]);
const DOWN_FOR_MS = 60_000; // an endpoint that failed or timed out is skipped this long

/**
 * Looks like one rpc.Server; each call goes to the first endpoint that isn't marked down, and on an
 * error or timeout moves on to the next (marking the failed one down for a minute). With a single
 * endpoint (local network) calls go straight through, without time limits.
 */
function failoverServer(urls) {
  const nodes = urls.map((url) => {
    const server = new rpc.Server(url, { allowHttp: url.startsWith("http://") });
    // The SDK adds X-Client-Name/-Version to every request; Gateway's CORS policy only allows
    // Content-Type, so browsers refused every call (preflight failed). They're telemetry only.
    if (FAST_RPC_URLS.has(url)) for (const h of ["X-Client-Name", "X-Client-Version"]) delete server.httpClient.defaults.headers[h];
    return { url, server, downUntil: 0 };
  });
  const notFound = (e) => e?.response?.status === 404 || /not found/i.test(e?.message ?? ""); // a real answer, not an outage
  const call = async (name, args) => {
    // Endpoints not marked down, in order of preference (all of them if every one is down).
    const now = Date.now();
    const up = nodes.filter((n) => n.downUntil <= now);
    const list = up.length ? up : nodes;
    if (nodes.length === 1 || NO_FAILOVER.has(name)) return list[0].server[name](...args);
    let last;
    for (const [i, n] of list.entries()) {
      // The last one left gets as long as it needs: a slow answer beats no answer.
      const limit = i === list.length - 1 ? 0 : (RPC_TIMEOUT_MS[name] ?? RPC_TIMEOUT_MS.default);
      let timer;
      try {
        const answer = n.server[name](...args);
        const r = await (limit ? Promise.race([answer, new Promise((_, reject) => (timer = setTimeout(
          () => reject(new Error(`${new URL(n.url).host} took over ${limit / 1000} s`)), limit)))]) : answer);
        n.downUntil = 0;
        return r;
      } catch (e) {
        if (notFound(e)) throw e;
        last = e;
        n.downUntil = Date.now() + DOWN_FOR_MS;
      } finally {
        clearTimeout(timer);
      }
    }
    throw last;
  };
  return new Proxy(nodes[0].server, {
    get(target, name) {
      const v = target[name];
      return typeof v === "function" ? (...args) => call(name, args) : v;
    },
  });
}

// How long a cached read may be reused within the same ledger (wall clock, ms).
const READ_TTL_MS = 4_000;
// Stellar RPC accepts at most 200 keys per getLedgerEntries request.
const MAX_KEYS = 200;

export class Chain {
  constructor(config) {
    this.config = config;
    this.server = failoverServer(config.rpcUrls ?? [config.rpcUrl]);
    // Read cache: identical reads in the same ledger share one request. Cleared whenever a newer
    // ledger is seen, after our own transactions (newEpoch) and after READ_TTL_MS at the latest.
    this.cache = new Map();
    this.ledger = 0; // latest ledger sequence seen
    // Read-your-writes: after our own transaction, reads must come from a node that has its ledger
    // (with two endpoints, the one answering could be a moment behind the one that included it).
    this.mustSee = 0;
    this.closeTime = null; // its close time (s), from getLatestLedger
    this.kinds = new Map(); // contract ID -> "pool" | "fx" | "router" | ... (for error messages)
    this.kinds.set(config.router, "router").set(config.factory, "factory");
    if (config.fx) this.kinds.set(config.fx.pool, "fx").set(config.fx.oracle, "oracle");
    if (config.faucet) this.kinds.set(config.faucet, "faucet");
    for (const desk of Object.values(config.kyc ?? {})) this.kinds.set(desk, "kyc");
    for (const [k, id] of Object.entries(config.tokens)) this.kinds.set(id, k === "limeContract" ? "token" : "sac");
  }

  kindOf = (id) => this.kinds.get(id);
  explain = (raw, calledId) => explainError(raw, this.kindOf, calledId);

  /** A newer ledger closed: everything cached may be out of date. */
  observeLedger(seq) {
    if (seq > this.ledger) {
      this.ledger = seq;
      this.cache.clear();
    }
  }

  /** Forget cached reads (after our own transaction, Friendbot, or an explicit refresh). */
  newEpoch() {
    this.cache.clear();
  }

  /** Run `fn` once per key per ledger (and READ_TTL_MS); failures are not cached. */
  cached(key, fn) {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < READ_TTL_MS) return hit.p;
    const p = fn();
    const entry = { p, at: Date.now() };
    this.cache.set(key, entry);
    p.catch(() => this.cache.get(key) === entry && this.cache.delete(key));
    return p;
  }

  /** Read-only call. Throws ChainError with a friendly message if the contract reverts. */
  read(contractId, method, ...args) {
    const key = `sim|${contractId}|${method}|${args.map((a) => a.toXDR("base64")).join(",")}`;
    return this.cached(key, () => this.simulate(contractId, method, args));
  }

  /** One uncached simulation. */
  async simulate(contractId, method, args) {
    const tx = new TransactionBuilder(new Account(READ_ONLY_SOURCE, "0"), { fee: BASE_FEE, networkPassphrase: this.config.passphrase })
      .addOperation(new Contract(contractId).call(method, ...args))
      .setTimeout(30)
      .build();
    const sim = await this.untilCurrent(() => this.server.simulateTransaction(tx), (r) => r.latestLedger);
    if (sim.latestLedger) this.observeLedger(sim.latestLedger);
    if (rpc.Api.isSimulationError(sim)) throw new ChainError(this.explain(sim.error, contractId), sim.error);
    return scValToNative(sim.result.retval);
  }

  /** Run a read again (briefly) while its answer predates our own last transaction (mustSee). */
  async untilCurrent(read, ledgerOf) {
    for (let i = 0; ; i++) {
      const r = await read();
      if (!this.mustSee || i >= 6 || !(ledgerOf(r) < this.mustSee)) return r;
      await new Promise((ok) => setTimeout(ok, 700));
    }
  }

  /** Our own transaction landed in `ledger`: later reads must include it. */
  wrote(ledger) {
    if (ledger) this.mustSee = Math.max(this.mustSee, Number(ledger));
    this.newEpoch();
  }

  /**
   * Many ledger entries in as few requests as possible (one per 200 keys, in parallel).
   * Returns { entries: Map(keyXdrBase64 -> entry), latestLedger }. Missing entries are absent.
   */
  async entries(keys) {
    const chunks = [];
    for (let i = 0; i < keys.length; i += MAX_KEYS) chunks.push(keys.slice(i, i + MAX_KEYS));
    const results = await Promise.all(chunks.map((c) => this.untilCurrent(() => this.server.getLedgerEntries(...c), (r) => r.latestLedger)));
    const entries = new Map();
    let latestLedger = 0;
    for (const r of results) {
      latestLedger = Math.max(latestLedger, r.latestLedger);
      for (const e of r.entries) entries.set(e.key.toXDR("base64"), e);
    }
    this.observeLedger(latestLedger);
    return { entries, latestLedger };
  }

  /** Latest ledger { sequence, closeTime } (cheap; drives the refresh cadence). */
  async latestLedger() {
    const l = await this.server.getLatestLedger();
    if (l.closeTime) this.closeTime = Number(l.closeTime);
    this.observeLedger(l.sequence);
    return { sequence: l.sequence, closeTime: this.closeTime };
  }

  /** Like read(), but returns {ok:false, error} instead of throwing. */
  async tryRead(contractId, method, ...args) {
    try {
      return { ok: true, value: await this.read(contractId, method, ...args) };
    } catch (e) {
      return { ok: false, error: e.message, raw: e.raw };
    }
  }

  /** Network time (latest ledger close), falling back to this computer's clock. */
  async now() {
    try {
      const l = await this.latestLedger();
      if (l.closeTime) return l.closeTime;
    } catch {}
    return Math.floor(Date.now() / 1000);
  }

  /**
   * Submit a contract call signed by `signer` ({ address, sign(xdr, passphrase) -> signed xdr }).
   * `onStatus` gets short progress messages for the UI. Returns { hash, result }.
   */
  async invoke(signer, contractId, method, args, onStatus = () => {}) {
    const { passphrase } = this.config;
    onStatus("Preparing transaction…");
    let account;
    try {
      account = await this.server.getAccount(signer.address);
    } catch {
      const e = new ChainError(`Your account ${signer.address.slice(0, 6)}… doesn't exist on ${this.config.network} yet. Fund it first (Testnet: Friendbot).`);
      e.needsFunding = true;
      throw e;
    }
    let tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: passphrase })
      .addOperation(new Contract(contractId).call(method, ...args))
      .setTimeout(120)
      .build();
    // A failed transaction changes nothing but the fee, so one retry with a fresh simulation is
    // safe. It covers state that moved between simulation and execution (see padOracleFootprint).
    for (let attempt = 1; ; attempt++) {
      // Simulation tells us the resources, fee and authorizations. If it fails, nothing is sent.
      const sim = await this.server.simulateTransaction(tx);
      if (rpc.Api.isSimulationError(sim)) throw new ChainError(this.explain(sim.error, contractId), sim.error);
      this.padOracleFootprint(sim);
      const prepared = rpc.assembleTransaction(tx, sim).build();

      onStatus(attempt > 1
        ? "The network moved on while your transaction was in flight (e.g. a new oracle price). Confirm once more…"
        : signer.prompt ?? "Waiting for your signature…");
      const signedXdr = await signer.sign(prepared.toXDR(), passphrase);
      onStatus("Submitting…");
      const sent = await this.server.sendTransaction(TransactionBuilder.fromXDR(signedXdr, passphrase));
      if (sent.status === "ERROR") {
        // SDK 17: XDR unions are plain objects with a `type` ("txBadSeq", "txFailed", …).
        const code = sent.errorResult?.result?.type ?? "rejected";
        throw new ChainError(this.explain(String(code), contractId), sent);
      }
      onStatus("Waiting for the network to include it (≈5 s)…");
      const res = await this.server.pollTransaction(sent.hash, { attempts: 30, sleepStrategy: () => 1000 });
      this.wrote(res.ledger); // our own transaction changed balances/reserves: no cached read is current
      if (res.ledger) this.observeLedger(res.ledger);
      if (res.status === "SUCCESS") return { hash: sent.hash, result: res.returnValue ? scValToNative(res.returnValue) : undefined };
      if (res.status !== "FAILED" || attempt >= 2) {
        throw new ChainError(`Transaction ${res.status.toLowerCase()} on-chain (${sent.hash.slice(0, 10)}…).`, res);
      }
      // Rebuild from the account's new sequence number (the failed transaction used one up).
      const fresh = await this.server.getAccount(signer.address);
      tx = new TransactionBuilder(fresh, { fee: BASE_FEE, networkPassphrase: passphrase })
        .addOperation(new Contract(contractId).call(method, ...args))
        .setTimeout(120)
        .build();
    }
  }

  /**
   * Make an oracle update between simulation and execution harmless.
   * A Soroban transaction must declare every storage entry it reads (its footprint), and the
   * simulation lists the entries read *at simulation time*. Reflector keeps each price round as a
   * temporary entry keyed by its timestamp (ms, one per resolution). LimeFX reads the recent
   * rounds on every swap, so if a new round is published in the seconds before execution, the
   * oracle reads a key the footprint never declared and the transaction fails ("access outside
   * the footprint"; seen on Testnet roughly once per 5-minute round). We declare the next two
   * round keys too (reading a key that doesn't exist yet is allowed) plus a little resource
   * headroom for the extra read. Oracles without timestamp-keyed rounds are left untouched.
   */
  padOracleFootprint(sim) {
    const oracle = this.config.fx?.oracle;
    const data = sim.transactionData;
    if (!oracle || !data) return;
    const built = data.build();
    const readOnly = [...built.resources.footprint.readOnly];
    const rounds = [];
    let template = null;
    for (const k of readOnly) {
      const cd = k.contractData;
      // SDK 17 enum values serialise to their name as JSON (String() would give raw XDR bytes).
      if (!cd || JSON.stringify(cd.durability) !== '"temporary"') continue;
      let addr, ts;
      try {
        addr = Address.fromScAddress(cd.contract).toString();
        ts = scValToNative(cd.key);
      } catch {
        continue;
      }
      if (addr !== oracle || typeof ts !== "bigint") continue;
      rounds.push(ts);
      template = k;
    }
    if (rounds.length < 2 || !template) return;
    rounds.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    let step = 0n;
    for (let i = 1; i < rounds.length; i++) {
      const d = rounds[i] - rounds[i - 1];
      if (d > 0n && (step === 0n || d < step)) step = d;
    }
    if (step === 0n) return;
    const last = rounds.at(-1);
    const have = new Set(rounds.map(String));
    const extra = [last + step, last + 2n * step].filter((t) => !have.has(String(t))).map((t) => {
      const key = xdr.LedgerKey.fromXDR(template.toXDR());
      key.contractData.key = nativeToScVal(t, { type: "u64" });
      return key;
    });
    if (!extra.length) return;
    const r = built.resources;
    data.setReadOnly([...readOnly, ...extra]);
    data.setResources(Math.ceil(Number(r.instructions) * 1.1), Number(r.diskReadBytes), Number(r.writeBytes));
    data.setResourceFee(BigInt(built.resourceFee) * 12n / 10n + 10_000n);
  }

  /** True if `address` exists on the network (has been funded). */
  async accountExists(address) {
    try {
      await this.server.getAccount(address);
      return true;
    } catch {
      return false;
    }
  }

  /** Ask Friendbot for test XLM (Testnet / local only). */
  async fundWithFriendbot(address) {
    if (!this.config.friendbot) throw new ChainError("No Friendbot on this network.");
    const r = await fetch(`${this.config.friendbot}?addr=${encodeURIComponent(address)}`);
    this.newEpoch();
    if (!r.ok && !(await this.accountExists(address))) throw new ChainError(`Friendbot couldn't fund the account (HTTP ${r.status}).`);
  }

  /**
   * Add trustlines for classic assets ("CODE:ISSUER") in one transaction (one changeTrust each).
   * A trustline is the account's opt-in to hold an asset; it locks 0.5 XLM of reserve each.
   */
  async addTrustlines(signer, assets, onStatus = () => {}) {
    const { passphrase } = this.config;
    onStatus("Preparing transaction…");
    const account = await this.server.getAccount(signer.address);
    const b = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: passphrase }).setTimeout(120);
    for (const a of assets) {
      const [code, issuer] = a.split(":");
      b.addOperation(Operation.changeTrust({ asset: new Asset(code, issuer) }));
    }
    const tx = b.build();
    onStatus(signer.prompt ?? "Waiting for your signature…");
    const signedXdr = await signer.sign(tx.toXDR(), passphrase);
    onStatus("Submitting…");
    const sent = await this.server.sendTransaction(TransactionBuilder.fromXDR(signedXdr, passphrase));
    if (sent.status === "ERROR") throw new ChainError(`The network rejected the trustline transaction (${sent.errorResult?.result?.type ?? "error"}).`, sent);
    onStatus("Waiting for the network to include it (≈5 s)…");
    const res = await this.server.pollTransaction(sent.hash, { attempts: 30, sleepStrategy: () => 1000 });
    this.wrote(res.ledger);
    if (res.status !== "SUCCESS") throw new ChainError(`Trustline transaction ${res.status.toLowerCase()} (${sent.hash.slice(0, 10)}…).`, res);
    return { hash: sent.hash };
  }

  txUrl(hash) {
    return this.config.explorer ? `${this.config.explorer}/tx/${hash}` : null;
  }
}

/**
 * Test-key signer for development (no wallet extension): a key Claude/the developer created for
 * testing, read from .env.local. Works on the local network and on Testnet only; refuses any other
 * network, and refuses to sign a transaction built for another network's passphrase.
 */
const DEV_PASSPHRASES = {
  local: "Standalone Network ; February 2017",
  testnet: "Test SDF Network ; September 2015",
};
export function devSigner(secret, network) {
  if (!DEV_PASSPHRASES[network]) throw new Error("The dev signer only works on the local network or Testnet.");
  const kp = Keypair.fromSecret(secret);
  return {
    kind: "dev",
    network,
    address: kp.publicKey(),
    prompt: network === "local" ? "Signing with the local dev key…" : "Signing with the Testnet QA key…",
    async sign(txXdr, passphrase) {
      if (passphrase !== DEV_PASSPHRASES[network]) throw new Error("Dev signer: refusing to sign for another network.");
      const tx = TransactionBuilder.fromXDR(txXdr, passphrase);
      tx.sign(kp);
      return tx.toXDR();
    },
  };
}
