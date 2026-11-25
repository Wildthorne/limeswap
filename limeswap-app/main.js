// LimeSwap web app: wiring (network, wallet, theme, tabs, refresh loop). Chain + routing logic lives
// in src/chain.js and src/dex.js (shared with smoke.mjs); each tab's DOM code lives in src/ui/.
import "@fontsource-variable/bricolage-grotesque"; // display face, self-hosted (no third-party font request)
import { Chain, devSigner, makeConfig } from "./src/chain.js";
import { loadState, loadTokens, loadTwaps, tokensCached } from "./src/dex.js";
import { esc, short } from "./src/format.js";
import { $, callout, banner, clearTransientBanner, openPicker, tip, toast } from "./src/ui/dom.js";
import * as poolsTab from "./src/ui/pools.js";
import * as swapTab from "./src/ui/swap.js";
import * as liquidityTab from "./src/ui/liquidity.js";
import * as onboarding from "./src/ui/onboarding.js";
import * as earnings from "./src/ui/earnings.js";

// Pick the network with VITE_NETWORK=local (npm run dev:local); default Testnet.
const NETWORK = import.meta.env.VITE_NETWORK || "testnet";
const appConfigs = import.meta.glob("../deployed.*.json", { eager: true, import: "default" });
const ammConfigs = import.meta.glob("../lime-amm/deployed.*.json", { eager: true, import: "default" });
const config = makeConfig(NETWORK, appConfigs[`../deployed.${NETWORK}.json`], ammConfigs[`../lime-amm/deployed.${NETWORK}.json`]);
const netName = NETWORK[0].toUpperCase() + NETWORK.slice(1);
$("net").textContent = netName;
$("foot-net").textContent = netName;

const app = {
  network: NETWORK,
  chain: new Chain(config),
  tokens: [],
  pools: [],
  fx: null,
  signer: null,
  listeners: [],
  // Listeners registered while a tab's init() runs belong to that tab: Swap and Liquidity only
  // re-read (balances, LP shares) while visible; a hidden one catches up when it is shown.
  registering: null,
  dirty: new Set(),
  onChange(fn) { this.listeners.push({ fn, tab: this.registering }); },
  changed() {
    for (const { fn, tab } of this.listeners) {
      if (tab && tab !== currentTab) this.dirty.add(tab);
      else fn();
    }
  },
  catchUp(tab) {
    if (!this.dirty.delete(tab)) return;
    for (const l of this.listeners) if (l.tab === tab) l.fn();
  },
  ledger: 0, // ledger of the state on screen
  account() { return this.signer ? { user: this.signer.address } : null; },
  async refresh(fresh = false) {
    // After a transaction (`fresh`), a refresh already in flight may have read the chain before the
    // transaction landed (on Testnet one usually is): queue one more instead of reusing it.
    if (fresh && this.refreshing) this.queued ??= this.refreshing.catch(() => {}).then(() => ((this.queued = null), this.refresh(true)));
    if (this.queued) return this.queued;
    if (fresh) {
      this.chain.newEpoch(); // drop every cached read (balances, LP shares, quotes)
      earnings.invalidate(); // and fetch the new pool events (our own deposit or swap)
    }
    // One refresh at a time: never overlap reads.
    this.refreshing ??= this.load(loadState(this.chain, { account: this.account(), fast: true })).finally(() => (this.refreshing = null));
    return this.refreshing;
  },
  async load(stateP) {
    const s = await stateP;
    this.pools = s.pools;
    this.fx = s.fx;
    this.fxError = s.fxError;
    this.ledger = s.ledger;
    this.updated = new Date();
    // A state read without the account part (the very first one on a first visit, or one that was
    // already in flight when a wallet connected): read again with it right away, once per wallet.
    if (this.signer && s.pools.every((p) => p.mine === undefined) && this.accountAsked !== this.signer.address) {
      this.accountAsked = this.signer.address;
      setTimeout(() => this.refresh(true), 0);
    }
    this.changed();
    setTimeout(() => (loadTwapsIfDue(), loadEarningsIfDue()), 0); // after paint
  },
  connect: () => openConnect(),
  // Cross-tab shortcuts (Pools → Trade / Add liquidity).
  trade(tokenIn, tokenOut) { swapTab.setPair(tokenIn, tokenOut); showTab("swap"); },
  provide(poolId) { liquidityTab.selectPool(poolId); showTab("liquidity"); },
};

// ---------- Signers ----------
const WALLET_LOGO = `<span class="wallet-logo" aria-hidden="true">V</span>`;
const MM_LOGO = `<span class="wallet-logo mm" aria-hidden="true">M</span>`;
const WALLET_LABEL = { dev: "dev key", freighter: "Varial", metamask: "MetaMask" };
async function openConnect() {
  // MetaMask signs Stellar through a Snap (an add-on inside MetaMask), and only on Testnet here.
  const { metaMaskStatus } = await import("./src/wallet.js");
  const mm = NETWORK === "testnet" ? await metaMaskStatus() : null;
  const mmNote = !mm ? "Testnet only"
    : !mm.installed ? "not found · install MetaMask first"
    : mm.snap ? "Stellar Snap added · community Snap"
    : "adds the Stellar Snap (community) on first connect";
  openPicker({
    title: "Plug in your wallet",
    searchable: false,
    hero: true,
    listClass: "wallets",
    intro: `Browsing is free. Your wallet only <strong>signs</strong>, and shows you every transaction first. Use <strong>${esc(netName)}</strong>.`,
    items: [
      { id: "freighter", search: "", html: `${WALLET_LOGO}<span class="t"><strong>Varial</strong><span>formerly Freighter · browser extension</span></span>`, right: "→" },
      { id: "metamask", search: "", html: `${MM_LOGO}<span class="t"><strong>MetaMask</strong><span>${esc(mmNote)}</span></span>`, right: "→" },
    ],
    footer: callout("zest", `No wallet? Get <a href="https://varialwallet.com/" target="_blank" rel="noopener">Varial</a> and switch it to <strong>Testnet</strong>.`
      + (NETWORK === "testnet" ? ` MetaMask works via the <a href="https://snaps.metamask.io/snap/npm/stellar-snap/" target="_blank" rel="noopener">Stellar Snap</a> ${tip("A community add-on, listed by MetaMask and audited. Connecting adds it and gives you a separate Stellar account.")}` : "")
      + ` Free test tokens come next.`),
    onPick: connectWallet,
  });
}
async function connectWallet(id) {
  try {
    const { connectFreighter, connectMetaMask } = await import("./src/wallet.js");
    app.signer = await (id === "metamask" ? connectMetaMask : connectFreighter)(config.passphrase, netName);
    try { localStorage.setItem(LAST_WALLET, id); } catch {}
    $("dev-badge").hidden = true;
    banner("");
    showAccount();
    toast(`Connected ${short(app.signer.address)}`, { ok: true });
    app.changed();
    app.refresh(true).catch(() => {}); // your positions and balances now, not at the next ledger
  } catch (e) {
    banner(e.message);
  }
}
$("connect").onclick = openConnect;

// After a reload, reconnect Varial silently if you connected it here before and it still allows this
// site on the right network (no popup). MetaMask waits for a click: its Snap isn't checked for this yet.
const LAST_WALLET = "limeswap-wallet";
function reconnect() {
  let last = null;
  try { last = localStorage.getItem(LAST_WALLET); } catch {}
  if (last !== "freighter") return;
  import("./src/wallet.js")
    .then(({ reconnectFreighter }) => reconnectFreighter(config.passphrase, netName))
    .then((signer) => {
      if (!signer || app.signer) return; // not allowed any more, or you connected meanwhile
      app.signer = signer;
      showAccount();
      app.changed();
      app.refresh(true).catch(() => {});
    })
    .catch(() => {});
}

// Dev signer (no wallet extension), development only:
// - local network: VITE_DEV_SECRET (CLI identity limeswap-tester);
// - Testnet QA mode (`npm run dev:qa`, VITE_QA=1): VITE_DEV_SECRET_TESTNET (identity limeswap-qa).
// vite.config.js strips both from production builds; devSigner() refuses every other network.
const DEV_SECRET = NETWORK === "local" ? import.meta.env.VITE_DEV_SECRET
  : NETWORK === "testnet" && import.meta.env.VITE_QA === "1" ? import.meta.env.VITE_DEV_SECRET_TESTNET
  : undefined;
if (DEV_SECRET) {
  app.signer = devSigner(DEV_SECRET, NETWORK);
  const badge = $("dev-badge");
  badge.hidden = false;
  if (NETWORK === "testnet") {
    badge.title = "Testnet QA mode: transactions are signed with a test key from .env.local (development server only)";
    badge.classList.add("qa");
  }
  showAccount();
} else {
  reconnect();
}

/** A small citrus-slice avatar derived from the address, so you recognise your account at a glance. */
function addressAvatar(addr) {
  let h = 0;
  for (const c of addr) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  // Everyone gets their own citrus: the slice's hue comes from the address (lime, orange, grapefruit…).
  const a = h % 360;
  return `<span class="avatar lime-slice" style="--seg:hsl(${a} 85% 58%);--seg-2:hsl(${a} 80% 52%);--rind:hsl(${a} 65% 30%)" aria-hidden="true"></span>`;
}
function showAccount() {
  const s = app.signer;
  $("account").innerHTML = `<button class="account" data-copy="${s.address}" title="${s.address} · ${WALLET_LABEL[s.kind]} (click to copy)" aria-label="Your account ${short(s.address)}, copy address">${addressAvatar(s.address)}<span class="addr">${short(s.address)}</span><span class="kind">${WALLET_LABEL[s.kind]}</span></button>`;
}

// ---------- Theme: follows the system until you pick one ----------
const prefersLight = () => matchMedia("(prefers-color-scheme: light)").matches;
const savedTheme = (() => { try { return localStorage.getItem("limeswap-theme"); } catch { return null; } })();
if (savedTheme) document.documentElement.dataset.theme = savedTheme;
$("theme").onclick = () => {
  const now = document.documentElement.dataset.theme ?? (prefersLight() ? "light" : "dark");
  const next = now === "light" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("limeswap-theme", next); } catch {}
};

// ---------- Tabs ----------
const TABS = ["swap", "pools", "liquidity"];
let currentTab = null;
let twapAt = 0, twapBusy = false; // lazy TWAP loading (see loadTwapsIfDue)
function showTab(tab) {
  if (!TABS.includes(tab)) tab = "swap";
  currentTab = tab;
  for (const b of document.querySelectorAll(".tabs button")) {
    const on = b.dataset.tab === tab;
    b.classList.toggle("active", on);
    if (on) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
  }
  for (const t of TABS) $(`tab-${t}`).hidden = t !== tab;
  if (location.hash.slice(1) !== tab) history.replaceState(null, "", `#${tab}`);
  app.catchUp(tab);
  if (tab === "pools") loadTwapsIfDue();
  loadEarningsIfDue();
}
for (const b of document.querySelectorAll(".tabs button")) b.onclick = () => showTab(b.dataset.tab);
window.addEventListener("hashchange", () => showTab(location.hash.slice(1)));
showTab(location.hash.slice(1) || "swap");

// ---------- Dev-only load timing (window.__lsPerf, ms since navigation; stripped from builds) ----------
if (import.meta.env.DEV) {
  const perf = (window.__lsPerf = {});
  const mark = (k) => perf[k] ??= Math.round(performance.now());
  new MutationObserver(() => {
    if (document.querySelector("#pool-list .pool-row") && document.querySelector("#fx-card .card")) mark("poolsRender");
    if (/ over \d+ min/.test(document.getElementById("pool-list")?.textContent ?? "")) mark("twapRender");
    if (document.querySelector("#routes .route-list li") && !document.querySelector("#swap-out-amount .sk")) mark("firstQuote");
  }).observe(document.body, { childList: true, subtree: true, characterData: true });
}

// ---------- TWAP: off the critical path (Pools tab only, at most every 60 s) ----------
const TWAP_EVERY_MS = 60_000;
async function loadTwapsIfDue() {
  if (currentTab !== "pools" || document.visibilityState !== "visible" || !app.pools.length || twapBusy) return;
  if (Date.now() - twapAt < TWAP_EVERY_MS) return;
  twapBusy = true;
  try {
    const pools = app.pools;
    await loadTwaps(app.chain, pools);
    twapAt = Date.now();
    if (app.pools === pools) app.changed(); // newer pool objects pick the TWAPs up from the cache
    else for (const p of app.pools) p.twap = app.chain.twaps.get(p.id) ?? p.twap;
  } finally {
    twapBusy = false;
  }
}

// ---------- LP fee earnings: pool events in the background, Pools and Liquidity tabs only ----------
function loadEarningsIfDue() {
  earnings.refreshIfDue(document.visibilityState === "visible" && (currentTab === "pools" || currentTab === "liquidity"));
}

// ---------- Refresh cadence: once per new ledger (~5 s), only while the page is visible ----------
let ticking = false;
async function tick() {
  if (document.visibilityState !== "visible" || ticking) return;
  ticking = true;
  try {
    const { sequence } = await app.chain.latestLedger();
    if (sequence > app.ledger) await app.refresh();
    clearTransientBanner();
    loadTwapsIfDue();
  } catch (e) {
    banner(`Refresh failed: ${e.message}`, true);
  } finally {
    ticking = false;
  }
}

// ---------- Start ----------
async function start() {
  // Token metadata is cached after the first visit: then the first state read (with the
  // account's balances) goes out at once; on a first visit, both requests go out together.
  let first = null;
  if (!tokensCached(app.chain)) (first = loadState(app.chain, { fast: true })).catch(() => {});
  try {
    app.tokens = await loadTokens(app.chain);
    first ??= loadState(app.chain, { account: app.account(), fast: true });
    for (const [tab, mod] of [["pools", poolsTab], ["swap", swapTab], ["liquidity", liquidityTab], [null, onboarding]]) {
      app.registering = tab === "pools" ? null : tab; // the Pools list re-renders on every refresh (no reads)
      mod.init(app);
    }
    app.registering = null;
    earnings.init(app);
    app.refreshing = app.load(first).finally(() => (app.refreshing = null));
    await app.refreshing;
  } catch (e) {
    banner(`Can't reach ${netName} (${config.rpcUrl}): ${e.message}${NETWORK === "local" ? ". Is the local network running? (stellar container start local)" : ""}`);
  }
  setInterval(tick, 5_000);
  document.addEventListener("visibilitychange", tick);
}
start();
