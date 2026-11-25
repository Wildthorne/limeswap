// Liquidity tab: your LP position, owed/claim, deposit at the pool ratio, withdraw by percentage,
// and (for compliance pools) whether the regulated token's issuer lets you in at all.
import { balanceOf, claimCall, depositCall, feeTierHelp, myPositions, pairedAmount, position, tierName, tokenById, trustStatus, usdPrices, withdrawCall } from "../dex.js";
import * as earn from "./earnings.js"; // positionNumbers() may arrive later: feature-detected
import { esc, fmtAmount, fmtBps, fmtPct, parseAmount, toInput } from "../format.js";
import { $, callout, icon, openPicker, pairAvatar, runTx, setHtml, slice, tip, tokenAvatar } from "./dom.js";
import { kycCallout, loadKyc, verify } from "./kyc.js";

let app;
let poolId = null; // selected pool's contract ID
let pool = null; // selected pool (LimeSwap pool object or LimeFX)
let me = null; // { pos, balA, balB, trustA, trustB }
let busy = false;

export function init(a) {
  app = a;
  $("lp-pool-btn").onclick = choosePool;
  $("dep-a").oninput = () => fill("a");
  $("dep-b").oninput = () => fill("b");
  $("wd-pct").oninput = renderWithdraw;
  $("wd-chips").onclick = (e) => {
    const b = e.target.closest("[data-pct]");
    if (b) { $("wd-pct").value = b.dataset.pct; renderWithdraw(); }
  };
  for (const b of document.querySelectorAll("#lp-actions .seg button")) b.onclick = () => setMode(b.dataset.mode);
  $("dep-go").onclick = deposit;
  $("wd-go").onclick = withdraw;
  $("lp-positions").onclick = (e) => {
    const more = e.target.closest("[data-more]");
    if (more) {
      const id = more.dataset.more;
      openDetails.has(id) ? openDetails.delete(id) : openDetails.add(id);
      return renderPositions();
    }
    const row = e.target.closest("[data-pos]");
    if (!row) return;
    select(row.dataset.pos, true);
    $("lp-actions").scrollIntoView({ behavior: "smooth", block: "nearest" });
  };
  app.onChange(() => {
    renderPositions();
    poolId ??= allPools()[0]?.id ?? null;
    if (!busy && poolId) select(poolId, false);
  });
}

/** Called from the Pools tab ("Add liquidity"). */
export function selectPool(id) {
  setMode("deposit");
  select(id, true);
}

function setMode(mode) {
  for (const b of document.querySelectorAll("#lp-actions .seg button")) b.setAttribute("aria-selected", String(b.dataset.mode === mode));
  $("lp-deposit").hidden = mode !== "deposit";
  $("lp-withdraw").hidden = mode !== "withdraw";
}

const tok = (id) => tokenById(app.tokens, id);
const sym = (id) => tok(id).symbol;
const dec = (id) => tok(id).decimals;
const amt = (v, id) => `${fmtAmount(v, dec(id))} ${esc(sym(id))}`;
const allPools = () => [...(app.fx ? [app.fx] : []), ...app.pools];
const poolTitle = (p) => `${esc(sym(p.tokenA))} / ${esc(sym(p.tokenB))}`;
const poolSub = (p) => (p.type === "fx" ? "Oracle-priced · dynamic fee" : `${tierName(p.feeBps)} · ${fmtBps(p.feeBps)} fee`);

const poolTags = (p) => (p.type === "fx" ? `<span class="tag">LimeFX</span>` : "")
  + (p.regulated.some(Boolean) ? `<span class="tag warn">compliance</span>` : "") + (p.paused ? `<span class="tag bad">paused</span>` : "");

// ---------- Your positions ----------

/** Has the connected account LP shares (or owed tokens) in this pool? (`mine` comes with the pool data.) */
export const isMine = (p) => Boolean(p.mine && (p.mine.shares > 0n || p.mine.owed.some((x) => x > 0n)));
const shareOf = (p) => (p.totalShares > 0n ? Number(p.mine.shares) / Number(p.totalShares) : 0);
/** Lime "You · 0.50%" badge for pools you're in (also used on the Pools tab). */
export const youBadge = (p) => (isMine(p) ? `<span class="tag you" title="Your share of this pool">You · ${fmtPct(shareOf(p), 2)}</span>` : "");
const openDetails = new Set(); // positions whose details are expanded (kept across refreshes)
// Dollars for P&L lines: cents normally, 4 decimals for Testnet-sized fractions.
const money = (x) => { const a = Math.abs(x); return a < 0.00005 ? "$0.00" : a < 0.0001 ? "< $0.0001" : `$${a.toLocaleString("en-US", a < 0.01 ? { minimumFractionDigits: 4, maximumFractionDigits: 4 } : { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; };
const signed = (x) => (!Number.isFinite(x) ? "–" : Math.abs(x) < 0.00005 ? "$0.00" : `${x >= 0 ? "+" : "−"}${money(x)}`);
const upDown = (x) => (!Number.isFinite(x) || Math.abs(x) < 0.0001 ? "" : x > 0 ? "up" : "down");
// "…worth $X today": how that compares with the position (vsHoldUsd = position − holding).
const vsHold = (x) => (Math.abs(x) < 0.005 ? ", the same as this position" : `, ${money(x)} ${x > 0 ? "less" : "more"} than this position`);
const day = (t) => new Date(t * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const POSITIONS_HELP = "Profit / loss = what your position is worth now minus what you put in (at the prices of that day). Fees earned are already inside \"worth now\". Open a position for the details. The app can see about 7 days of history: older deposits are counted from when tracking started.";
/** P&L numbers for a position, once the earnings data has them; null otherwise. */
function pnlOf(p) {
  if (typeof earn.positionNumbers !== "function") return null; // data not wired in yet: no P&L shown
  const n = earn.positionNumbers(p);
  if (!n || !Number.isFinite(n.entryUsd) || n.entryUsd <= 0) return n === undefined ? undefined : null;
  return { ...n, pnl: n.nowUsd - n.entryUsd, pct: (n.nowUsd - n.entryUsd) / n.entryUsd };
}
const fmtUsd = (x) => (!Number.isFinite(x) ? "–" : x < 0.01 ? "< $0.01" : `$${x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const poolKind = (p) => (p.type === "fx" ? "LimeFX" : `LimeSwap ${fmtBps(p.feeBps)}`);

function renderPositions() {
  const box = $("lp-positions");
  const loaded = app.signer && [...allPools()].some((p) => p.mine !== undefined);
  $("lp-positions-card").hidden = !app.signer;
  if (!app.signer) return;
  if (!loaded) return setHtml(box, `<div class="pos-head"><h2>Your positions</h2></div><span class="sk sk-row"></span>`);
  const { positions, totalUsd, allPriced } = myPositions(app.pools, app.fx, app.tokens);
  if (!positions.length) {
    return setHtml(box, `<div class="pos-head"><h2>Your positions</h2></div>
      <div class="pos-empty">${slice()}<div><strong>No positions yet</strong><span>Add liquidity below and earn a slice of every swap fee.</span></div></div>`);
  }
  const rows = positions.map((x) => {
    const p = x.pool, A = sym(p.tokenA), B = sym(p.tokenB);
    const owed = x.owed.some((v) => v > 0n);
    const k = pnlOf(p);
    const open = openDetails.has(p.id);
    const label = `${A} / ${B}, ${poolKind(p)}, your share ${fmtPct(x.share, 2)}, worth about ${fmtUsd(x.usd)}${k ? `, ${k.pnl >= 0 ? "up" : "down"} ${money(k.pnl)} since you put it in` : ""}${owed ? ", tokens owed to you: claim them" : ""}. Select this pool`;
    const pnlChip = k ? `<span class="pnl ${upDown(k.pnl)}">${k.pnl >= 0 ? "▲" : "▼"} ${money(k.pnl)} · ${(Math.abs(k.pct) * 100).toFixed(1)}%</span>`
      : k === undefined ? `<span class="sk" style="width:84px;height:12px"></span>` : "";
    return `<div class="pos-item${p.id === poolId ? " current" : ""}">
      <button class="pos-row" data-pos="${p.id}" aria-label="${esc(label)}"${p.id === poolId ? ` aria-current="true"` : ""}>
        ${pairAvatar(tok(p.tokenA), tok(p.tokenB))}
        <span class="t"><strong>${esc(A)} / ${esc(B)} <span class="tag">${poolKind(p)}</span>${p.regulated.some(Boolean) ? `<span class="tag warn">compliance</span>` : ""}${owed ? `<span class="tag warn">owed · claim</span>` : ""}</strong>
          <span>${fmtPct(x.share, 2)} of pool</span></span>
        <span class="usd">${fmtUsd(x.usd)}${pnlChip}</span>
      </button>
      <button class="pos-more" data-more="${p.id}" aria-expanded="${open}" aria-controls="pos-d-${p.id}" aria-label="${open ? "Hide" : "Show"} details for ${esc(A)} / ${esc(B)}">${icon.chevron}</button>
      ${open ? positionDetails(x, k) : ""}
    </div>`;
  });
  const ks = positions.map((x) => pnlOf(x.pool));
  const total = ks.every((k) => k) ? ks.reduce((t, k) => t + k.pnl, 0) : null;
  setHtml(box, `<div class="pos-head"><h2>Your positions ${tip(POSITIONS_HELP)}</h2><span class="pos-total">≈ ${fmtUsd(totalUsd)}${total !== null ? `<span class="pnl ${upDown(total)}">${total >= 0 ? "▲" : "▼"} ${money(total)}</span>` : ""}${allPriced ? "" : ` ${tip("Some tokens have no price route to USD, so they're left out of the total.")}`}</span></div>
    <div class="pos-list">${rows.join("")}</div>`);
}

/** The expanded part of a position: plain numbers, one comparison sentence. */
function positionDetails(x, k) {
  const p = x.pool, n = k ?? (typeof earn.positionNumbers === "function" ? earn.positionNumbers(p) : null); // undefined = loading
  const stat = (label, value, cls = "", sub = "") => `<div class="stat-mini"><span class="k">${label}</span><b class="${cls}">${value}</b>${sub ? `<small>${sub}</small>` : ""}</div>`;
  const cells = [];
  if (k) cells.push(stat("You put in", money(k.entryUsd), "", k.entryKnown ? day(k.entryAt) : `since ${day(k.entryAt)} · tracking start`));
  cells.push(stat("Worth now", fmtUsd(x.usd)));
  if (k) cells.push(stat("Profit / loss", signed(k.pnl), upDown(k.pnl), `${k.pnl >= 0 ? "+" : "−"}${(Math.abs(k.pct) * 100).toFixed(1)}%`));
  if (n && Number.isFinite(n.feesUsd)) cells.push(stat("Fees earned", signed(n.feesUsd), upDown(n.feesUsd)));
  else if (n === undefined) cells.push(`<div class="stat-mini"><span class="k">Fees earned</span><span class="sk" style="height:18px;width:64px" aria-label="Loading"></span></div>`); // history still loading
  const amounts = `${fmtAmount(x.amountA, dec(p.tokenA), 2)} ${esc(sym(p.tokenA))} + ${fmtAmount(x.amountB, dec(p.tokenB), 2)} ${esc(sym(p.tokenB))}`;
  const hold = n && Number.isFinite(n.holdUsd)
    ? `<p class="caption">If you'd kept the tokens in your wallet instead, they'd be worth <strong>${money(n.holdUsd)}</strong> today${vsHold(n.vsHoldUsd)}. ${tip("Pools rebalance as prices move: when one token rises, traders buy it from the pool, so you end up with less of the winner. That gap is called impermanent loss; fees make up for part of it.")}</p>` : "";
  return `<div class="pos-details" id="pos-d-${p.id}">
    <div class="pos-stats-grid">${cells.join("")}</div>
    <p class="caption">Your tokens in the pool: ${amounts}</p>
    ${hold}
  </div>`;
}

function renderPoolButton() {
  if (!pool) return;
  $("lp-pool-btn").setAttribute("aria-label", `Pool: ${sym(pool.tokenA)} / ${sym(pool.tokenB)}, ${poolSub(pool).replace(" · ", ", ")}${pool.paused ? ", paused" : ""}. Change pool`);
  setHtml("lp-pool-btn", `${pairAvatar(tok(pool.tokenA), tok(pool.tokenB), "lg")}<span class="t"><strong>${poolTitle(pool)} ${poolTags(pool)}</strong><span>${poolSub(pool)}</span></span>${icon.chevron}`);
  // Same pair in several fee tiers (or a special-purpose pool): say why, so it isn't read as a duplicate.
  const help = feeTierHelp(pool, app.pools, app.chain.config.poolNotes);
  const multi = help && app.pools.some((p) => p.type !== "fx" && p.id !== pool.id
    && [p.tokenA, p.tokenB].includes(pool.tokenA) && [p.tokenA, p.tokenB].includes(pool.tokenB));
  $("lp-pool-note").hidden = !help;
  setHtml("lp-pool-note", help ? `${multi ? `Why more than one ${poolTitle(pool)} pool?` : "About this pool"} ${tip(help)}` : "");
}

/** Total value locked in a pool, ≈ USD (same prices as "Your positions"); NaN if a token has no price. */
export function tvlOf(p, prices) {
  const side = (id, raw) => (prices.has(id) ? (Number(raw) / 10 ** dec(id)) * prices.get(id) : NaN);
  return side(p.tokenA, p.reserveA) + side(p.tokenB, p.reserveB);
}
export const fmtTvl = (x) => (!Number.isFinite(x) ? "–" : x >= 10_000
  ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 }).format(x)
  : `$${Math.round(x).toLocaleString("en-US")}`);

function choosePool() {
  const prices = usdPrices(app.pools, app.fx, app.tokens);
  const tvl = new Map(allPools().map((p) => [p.id, tvlOf(p, prices)]));
  const size = (p) => (Number.isFinite(tvl.get(p.id)) ? tvl.get(p.id) : -1);
  openPicker({
    title: "Choose a pool",
    placeholder: "Search pair, e.g. LEUR",
    filter: allPools().some(isMine) ? { label: "My pools", key: "mine", on: false } : null,
    // Your pools first, then by TVL (biggest first), like DEX pool lists.
    items: () => [...allPools()].sort((x, y) => Number(isMine(y)) - Number(isMine(x)) || size(y) - size(x)).map((p) => ({
      id: p.id,
      mine: isMine(p),
      current: p.id === poolId,
      search: `${sym(p.tokenA)} ${sym(p.tokenB)} ${poolSub(p)} ${p.regulated.some(Boolean) ? "compliance regulated" : ""}`,
      html: `${pairAvatar(tok(p.tokenA), tok(p.tokenB))}<span class="t"><strong>${poolTitle(p)} ${youBadge(p)}${poolTags(p)}</strong><span>${poolSub(p)}</span></span>`,
      right: `${fmtTvl(tvl.get(p.id))}<small>TVL</small>`,
    })),
    onPick: (id) => select(id, true),
  });
}

async function select(id, reset) {
  const switching = poolId !== id || pool?.id !== id;
  poolId = id;
  pool = allPools().find((p) => p.id === id) ?? null;
  if (!pool) return;
  if (reset) {
    $("dep-a").value = $("dep-b").value = "";
    $("wd-pct").value = 0;
    $("lp-status").innerHTML = "";
  }
  $("dep-a-sym").innerHTML = `${tokenTag(pool.tokenA)}`;
  $("dep-b-sym").innerHTML = `${tokenTag(pool.tokenB)}`;
  $("dep-a").setAttribute("aria-label", `${sym(pool.tokenA)} amount to deposit`);
  $("dep-b").setAttribute("aria-label", `${sym(pool.tokenB)} amount to deposit`);
  renderPoolButton();
  renderPositions();
  // Keep the last known position while a refresh of the same pool is in flight: on public RPC
  // the reads below take seconds, and clearing `me` here left buttons acting on null.
  if (switching || !app.signer || me?.user !== app.signer.address) me = null; // another wallet: its numbers aren't yours
  if (switching) {
    // The old pool's preview must not stay on screen (with an enabled button) while the new one loads.
    $("wd-note").innerHTML = "";
    $("wd-go").disabled = $("dep-go").disabled = true;
    $("wd-pct-label").textContent = `${$("wd-pct").value}%`;
  }
  renderInfo();
  fill(null); // "Loading your balances…" (or "Connect wallet") right away, not a bare "Deposit"
  renderWithdraw();
  if (app.signer) {
    const u = app.signer.address;
    const [pos, balA, balB, trustA, trustB, kycA, kycB] = await Promise.all([
      position(app.chain, pool, u), balanceOf(app.chain, pool.tokenA, u), balanceOf(app.chain, pool.tokenB, u),
      trustStatus(app.chain, tok(pool.tokenA), u), trustStatus(app.chain, tok(pool.tokenB), u),
      loadKyc(app, tok(pool.tokenA), u).catch(() => null), loadKyc(app, tok(pool.tokenB), u).catch(() => null),
    ]);
    if (pool?.id !== id) return;
    me = { user: u, pos, balA, balB, trustA, trustB, kycA, kycB };
  }
  renderInfo();
  fill(null);
  renderWithdraw();
}


const tokenTag = (id) => `${tokenAvatar(tok(id), "sm")}${esc(sym(id))}`;

function renderInfo() {
  const p = pool;
  let html = `<dl class="rows">
    <dt>Pool reserves</dt><dd>${amt(p.reserveA, p.tokenA)}<small>${amt(p.reserveB, p.tokenB)}</small></dd>
  </dl>`;
  const notes = [];
  if (me && p.type === "limeswap") {
    const [oa, ob] = me.pos.owed;
    notes.push(oa > 0n || ob > 0n
      ? callout("warn", `The pool owes you ${amt(oa, p.tokenA)} and ${amt(ob, p.tokenB)} from a withdrawal it couldn't pay out (e.g. your trustline was frozen at the time).<br><button class="btn btn-lime btn-sm" id="claim">Claim</button>`)
      : "");
  }
  if (p.paused) notes.push(callout("bad", "This pool is paused: deposits are off, withdrawals still work."));
  notes.push(...complianceNotes());
  if (notes.length) html += `<div class="stack">${notes.join("")}</div>`;
  setHtml("lp-info", html);
  if ($("claim")) $("claim").onclick = () => act($("claim"), claimCall(pool, app.signer.address), () => "What the pool owed you is back in your wallet.", { kicker: "Claimed" });
}

/** A regulated token in this pool you can still get approved for at its demo KYC desk (id), or null. */
function kycTarget() {
  if (!me || pool.paused) return null;
  const sides = [[pool.tokenA, me.trustA, me.kycA], [pool.tokenB, me.trustB, me.kycB]];
  return sides.find(([, t, k]) => k && t !== "authorized" && k.status === "unverified")?.[0] ?? null;
}

/** The main Deposit button runs the KYC check while that's what's missing (one button, not two). */
async function runVerify(id) {
  busy = true;
  await verify(app, $("dep-go"), $("lp-status"), tok(id));
  busy = false;
  await select(pool.id, false);
}

/** Why a deposit / transfer would be blocked, before the user tries. Returns callout HTML strings. */
function complianceNotes() {
  if (!me) return [];
  const out = [];
  const sides = [[pool.tokenA, me.trustA, pool.regulated[0], me.kycA], [pool.tokenB, me.trustB, pool.regulated[1], me.kycB]];
  for (const [id, trust, regulated, kyc] of sides) {
    const s = esc(sym(id));
    const verifyNote = kycCallout(tok(id), trust, kyc, { button: false });
    if (verifyNote) {
      out.push(verifyNote);
    } else if (regulated) {
      if (trust === "authorized") out.push(callout("good", `Compliance pool: ${s}'s issuer approved your account, so you can deposit.`));
      else if (trust === "missing") out.push(callout("bad", `Compliance pool: ${s} is regulated and you have no ${s} trustline, so deposits are rejected. ${tip(`(Error #14.) Add the ${s} trustline in your wallet, then ask the issuer to authorize it. Until then nobody can send you LP shares of this pool either.`)}`));
      else out.push(callout("bad", `Compliance pool: your ${s} trustline isn't approved (or was frozen), so deposits are rejected.${me.pos.shares > 0n ? ` A withdrawal now is held as "owed" until you're re-approved; then press Claim.` : ""} ${tip(`New ${s} trustlines start unapproved; only the issuer can approve or unfreeze them. LP-share transfers are blocked too.`)}`));
    } else if (trust === "missing") {
      out.push(callout("warn", `You have no ${s} trustline: add it in your wallet first.`));
    } else if (trust === "frozen") {
      out.push(callout("warn", `Your ${s} trustline is frozen by its issuer.${pool.type === "fx" ? " LimeFX withdrawals fail until you're unfrozen." : " A withdrawal would be held as \"owed\" until then."}`));
    }
  }
  return out;
}

/** Blocking reason for a deposit, or null. Short enough to be the button label. */
function depositBlocker(a, b) {
  if (!me) return "Loading your balances…";
  if (pool.paused) return "Pool is paused";
  const sides = [[me.trustA, pool.regulated[0]], [me.trustB, pool.regulated[1]]];
  if (sides.some(([t, r]) => r && t !== "authorized")) return "Blocked by compliance";
  if (sides.some(([t]) => t === "missing" || t === "frozen")) return "Fix the trustline first";
  if (!a || !b) return "Enter an amount";
  if (me.balA === null || me.balB === null) return "Couldn't read your balances";
  if (a > me.balA) return `Insufficient ${sym(pool.tokenA)}`;
  if (b > me.balB) return `Insufficient ${sym(pool.tokenB)}`;
  return null;
}

// Typing one side fills the other at the pool's current ratio (same rounding as the contract).
function fill(side) {
  if (!pool) return;
  const empty = pool.totalShares === 0n;
  if (side && !empty) {
    const from = side === "a" ? pool.tokenA : pool.tokenB;
    const v = parseAmount($(`dep-${side}`).value, dec(from));
    const other = v ? pairedAmount(pool, side, v) : null;
    const d = dec(side === "a" ? pool.tokenB : pool.tokenA), step = 10n ** BigInt(Math.max(0, d - 4));
    $(side === "a" ? "dep-b" : "dep-a").value = other ? toInput(other - (other % step), d) : "";
  }
  const a = parseAmount($("dep-a").value, dec(pool.tokenA)), b = parseAmount($("dep-b").value, dec(pool.tokenB));
  for (const [s, v, bal, id] of me ? [["a", a, me.balA, pool.tokenA], ["b", b, me.balB, pool.tokenB]] : []) {
    $(`dep-${s}`).classList.toggle("over", Boolean(v && bal !== null && v > bal));
    $(`dep-${s}-bal`).innerHTML = `Balance ${fmtAmount(bal, dec(id))} <button class="link-btn" data-max="${s}" aria-label="Use your whole ${esc(sym(id))} balance">Max</button>`;
  }
  for (const m of document.querySelectorAll("#lp-deposit [data-max]")) m.onclick = () => {
    const s = m.dataset.max, bal = s === "a" ? me.balA : me.balB;
    if (bal === null) return;
    $(`dep-${s}`).value = toInput(bal, dec(s === "a" ? pool.tokenA : pool.tokenB));
    fill(s);
  };
  if (!me) $("dep-a-bal").textContent = $("dep-b-bal").textContent = "";
  const kycId = app.signer ? kycTarget() : null;
  const blocker = app.signer && !kycId ? depositBlocker(a, b) : null;
  const ratioNote = empty
    ? "This pool is empty: your deposit sets its starting price, so enter both amounts at the price you want."
    : `Deposit ratio 1 ${esc(sym(pool.tokenA))} : ${(Number(pool.reserveB) / Number(pool.reserveA)).toPrecision(5)} ${esc(sym(pool.tokenB))} ${tip("Type one amount; the other fills in at the pool's ratio. You get LP shares, which earn the swap fees. Minimums sit 1% below, so a sudden price move cancels the deposit instead of filling at a bad ratio.")}`;
  const share = !empty && a ? `<br>You'd own about <strong>${fmtPct(Number(a) / Number(pool.reserveA + a), 3)}</strong> of the pool.` : "";
  $("dep-note").innerHTML = `${ratioNote}${share}`;
  if (busy) return;
  $("dep-go").textContent = !app.signer ? "Connect wallet" : kycId ? "Verify me (demo KYC)" : blocker ?? `Deposit ${sym(pool.tokenA)} + ${sym(pool.tokenB)}`;
  $("dep-go").disabled = Boolean(blocker);
}

function sharesToWithdraw() {
  if (!me || me.pos.shares === null) return 0n;
  const pct = BigInt($("wd-pct").value);
  return pct === 100n ? me.pos.shares : (me.pos.shares * pct) / 100n;
}

function renderWithdraw() {
  if (!pool) return;
  if (!app.signer) {
    $("wd-note").innerHTML = `<p class="caption">Connect a wallet to see your shares in this pool.</p>`;
    if (!busy) { $("wd-go").textContent = "Connect wallet"; $("wd-go").disabled = false; }
    return;
  }
  if (!me) return;
  const pct = $("wd-pct").value;
  $("wd-pct-label").textContent = `${pct}%`;
  $("wd-pct").style.setProperty("--p", `${pct}%`);
  for (const c of document.querySelectorAll("#wd-chips [data-pct]")) c.classList.toggle("on", c.dataset.pct === pct);
  const shares = sharesToWithdraw();
  let label = "Withdraw";
  if (me.pos.shares === null) {
    $("wd-note").innerHTML = callout("warn", "Couldn't read your LP shares; retrying on the next refresh.");
    label = "Couldn't read your shares";
  } else if (me.pos.shares === 0n) {
    $("wd-note").innerHTML = `<p class="caption">You have no LP shares in this pool.</p>`;
    label = "No LP shares to withdraw";
  } else {
    const a = pool.totalShares ? (shares * pool.reserveA) / pool.totalShares : 0n;
    const b = pool.totalShares ? (shares * pool.reserveB) / pool.totalShares : 0n;
    $("wd-note").innerHTML = `<dl class="rows">
        <dt>Shares returned</dt><dd>${fmtAmount(shares)}</dd>
        <dt>You receive (about) ${tip("Cancels if you'd get under 99% of this. Works even when the pool is paused.")}</dt><dd>${amt(a, pool.tokenA)}<small>${amt(b, pool.tokenB)}</small></dd>
      </dl>`;
    if (shares === 0n) label = "Choose an amount";
  }
  if (busy) return;
  $("wd-go").textContent = label;
  $("wd-go").disabled = shares === 0n;
}

async function act(button, call, describe, opts) {
  busy = true;
  await runTx(app, button, $("lp-status"), call, describe, opts);
  busy = false;
  await select(pool.id, false);
}

async function deposit() {
  if (!app.signer) return app.connect();
  if (kycTarget()) return runVerify(kycTarget());
  const a = parseAmount($("dep-a").value, dec(pool.tokenA)), b = parseAmount($("dep-b").value, dec(pool.tokenB));
  if (depositBlocker(a, b)) return;
  act($("dep-go"), depositCall(app.chain, pool, app.signer.address, a, b, 100, await app.chain.now()), (r) =>
    `For ${fmtAmount(r[0], dec(pool.tokenA))} ${sym(pool.tokenA)} + ${fmtAmount(r[1], dec(pool.tokenB))} ${sym(pool.tokenB)}.`,
    { kicker: "Poured in", headline: (r) => `+${fmtAmount(r[2])} <small>LP shares</small>` })
    .then(() => {
      $("dep-a").value = $("dep-b").value = "";
      fill(null);
    });
}

function withdraw() {
  if (!app.signer) return app.connect();
  const shares = sharesToWithdraw();
  if (shares === 0n) return;
  act($("wd-go"), withdrawCall(pool, app.signer.address, shares, 100), (r) =>
    `You withdrew ${fmtAmount(r[0], dec(pool.tokenA))} ${sym(pool.tokenA)} + ${fmtAmount(r[1], dec(pool.tokenB))} ${sym(pool.tokenB)}.`,
    { kicker: "Back in your wallet" })
    .then(() => {
      $("wd-pct").value = 0;
      renderWithdraw();
    });
}
