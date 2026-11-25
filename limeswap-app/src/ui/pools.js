// Pools tab: the LimeFX featured card + every LimeSwap pool from the factory. Re-rendered on each refresh.
import { feeTierHelp, kycDesk, kycStatus, tierName, tokenById, usdPrices } from "../dex.js";
import { esc, fmtAge, fmtAmount, fmtBps, fmtPrice, short } from "../format.js";
import { $, callout, copyBtn, icon, pairAvatar, setHtml, slice, tip } from "./dom.js";
import { aprTag, poolFeeRows } from "./earnings.js";
import { fmtTvl, tvlOf, youBadge } from "./liquidity.js";

let app;
let fxMoreOpen = false;

export function init(a) {
  app = a;
  app.onChange(render);
  // keep "Pool details" (LimeFX) open across refreshes once you've opened it
  $("fx-card").addEventListener("toggle", (e) => e.target.classList.contains("fx-more") && (fxMoreOpen = e.target.open), true);
  $("pool-list").addEventListener("click", (e) => {
    const b = e.target.closest("[data-trade],[data-provide]");
    if (!b) return;
    if (b.dataset.trade) app.trade(...b.dataset.trade.split(","));
    else app.provide(b.dataset.provide);
  });
  // Keep the "Updated … ago" chip honest between refreshes.
  setInterval(renderUpdated, 1000);
}

function renderUpdated() {
  if (!app.updated) return;
  const age = Math.round((Date.now() - app.updated) / 1000);
  const el = $("updated");
  el.classList.toggle("stale", age > 30);
  // Build the pulsing dot once and only update the text: re-creating the dot every second
  // restarted its 2 s pulse halfway through, so it never completed a loop.
  if (!el.querySelector(".dot") || !el.querySelector("span")) el.innerHTML = `<i class="dot pulse"></i><span></span>`;
  // Fresh data needs no label; only say something when it's getting old (connection trouble).
  el.querySelector("span").textContent = age > 30 ? `Prices are ${age} s old · reconnecting…` : "";
  el.hidden = age <= 30;
}

let tvl = new Map(); // pool id → ≈ USD TVL for this render

// Your status at a regulated token's demo KYC desk ("address:token" → status), so its pool row can
// say "verify to trade" until you have. Read in the background, again at most once a minute.
const kyc = new Map();
function kycOf(id) {
  const t = tok(id), me = app.signer?.address;
  if (!me || !kycDesk(app.chain, t)) return null;
  const key = `${me}:${id}`, c = kyc.get(key);
  if (!c || Date.now() - c.at > 60_000) {
    kyc.set(key, { status: c?.status, at: Date.now() });
    kycStatus(app.chain, t, me).then((status) => { if (status !== c?.status) { kyc.set(key, { status, at: Date.now() }); app.changed(); } }).catch(() => {});
  }
  return c?.status;
}

function render() {
  renderUpdated();
  const prices = usdPrices(app.pools, app.fx, app.tokens);
  tvl = new Map([...(app.fx ? [app.fx] : []), ...app.pools].map((p) => [p.id, tvlOf(p, prices)]));
  setHtml("fx-card", app.fx ? fxCard(app.fx) : app.fxError ? `<div class="card fx"><h2>LimeFX</h2>${callout("bad", esc(app.fxError))}</div>` : "");
  $("pool-count").textContent = "";
  // Re-rendering replaces the rows; keep the ones you expanded open.
  const open = [...document.querySelectorAll(".pool-row[open]")].map((d) => d.dataset.id);
  setHtml("pool-list", app.pools.length
    ? `<div class="pool-head" aria-hidden="true"><span>Pool</span><span>Reserves</span><span>Price now</span><span>10-min TWAP</span><span></span></div>${[...app.pools].sort(byTvlGroup).map(poolRow).join("")}`
    : `<div class="empty-state">${slice()}<strong>No pools yet</strong><span>The factory hasn't squeezed out a single pool on this network.</span></div>`);
  for (const id of open) document.querySelector(`.pool-row[data-id="${id}"]`)?.setAttribute("open", "");
}

const tok = (id) => tokenById(app.tokens, id);
const sym = (id) => esc(tok(id).symbol);
const amt = (v, id) => `${fmtAmount(v, tok(id).decimals, 2)} ${sym(id)}`;

const pairKey = (p) => [tok(p.tokenA).symbol, tok(p.tokenB).symbol].sort().join("/");
const byPair = (x, y) => pairKey(x).localeCompare(pairKey(y)) || x.feeBps - y.feeBps;
// Biggest pairs first (by their largest pool's TVL); a pair's fee tiers stay together, lowest fee first.
const tvlNum = (p) => (Number.isFinite(tvl.get(p.id)) ? tvl.get(p.id) : -1);
const groupTvl = (p) => Math.max(...app.pools.filter((q) => pairKey(q) === pairKey(p)).map(tvlNum));
const byTvlGroup = (x, y) => groupTvl(y) - groupTvl(x) || byPair(x, y);

function poolRow(p) {
  const a = sym(p.tokenA), b = sym(p.tokenB);
  const help = feeTierHelp(p, app.pools, app.chain.config.poolNotes);
  const tags = [youBadge(p), `<span class="tag">${tierName(p.feeBps)} · ${fmtBps(p.feeBps)} fee</span>${help ? tip(help) : ""}`, aprTag(p)].filter(Boolean);
  p.regulated.forEach((on, i) => {
    if (!on) return;
    const s = i ? b : a, desk = kycDesk(app.chain, tok(i ? p.tokenB : p.tokenA)), st = desk ? kycOf(i ? p.tokenB : p.tokenA) : null;
    // No wallet: everyone starts unverified. With one: only once we know (no flash for verified accounts).
    tags.push(desk && (app.signer ? st === "unverified" : true)
      ? `<span class="tag warn" title="${s} is regulated: verify once (demo KYC) on Swap or Liquidity, then you can trade it and add liquidity">${s} · verify to trade</span>`
      : `<span class="tag warn" title="The issuer of ${s} requires every LP to hold an authorized trustline">compliance · ${s}</span>`);
  });
  if (p.paused) tags.push(`<span class="tag bad">paused</span>`);
  if (p.totalShares === 0n) tags.push(`<span class="tag">empty</span>`);
  const gap = p.twap.price ? Math.abs(p.mid / p.twap.price - 1) : 0;
  if (gap > 0.02) tags.push(`<span class="tag warn">moving</span>`);
  const twap = p.twap.price
    ? `${fmtPrice(p.twap.price)} <small>${b} per ${a}</small>`
    : `<span class="muted" title="${esc(p.twap.error ?? "")}">–</span><small>${p.twap.pending ? "loading…" : "not enough history yet"}</small>`;
  return `<details class="pool-row" data-id="${p.id}">
    <summary>
      ${pairAvatar(tok(p.tokenA), tok(p.tokenB))}<strong class="pname">${a} / ${b}</strong>
      <span class="c price">${fmtTvl(tvl.get(p.id))} <small>TVL</small></span>
      <svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
      <span class="tags">${tags.join("")}</span>
    </summary>
    <div class="more">
      <dl class="rows">
        <dt>Price</dt><dd>1 ${a} = ${fmtPrice(p.mid)} ${b}<small>1 ${b} = ${fmtPrice(1 / p.mid)} ${a}</small></dd>
        <dt>Reserves</dt><dd>${amt(p.reserveA, p.tokenA)}<small>${amt(p.reserveB, p.tokenB)}</small></dd>
        <dt>10-min average ${tip("Time-weighted average price over about the last 10 minutes: hard to manipulate in a single transaction.")}</dt><dd>${twap}</dd>
        ${poolFeeRows(p)}
      </dl>
      ${gap > 0.02 ? callout("warn", `Price is ${(gap * 100).toFixed(1)}% off its 10-minute average: a big trade just moved it.`) : ""}
      <div class="actions">
        <button class="btn btn-ghost btn-sm" data-trade="${p.tokenA},${p.tokenB}">Trade ${a} → ${b}</button>
        <button class="btn btn-ghost btn-sm" data-provide="${p.id}">Add liquidity</button>
      </div>
      <div class="sub">Pool contract: ${copyBtn(p.id, short(p.id))}</div>
    </div>
  </details>`;
}

function fxCard(f) {
  const a = sym(f.tokenA), b = sym(f.tokenB);
  const maxAge = Number(f.params.max_age);
  let age = `<span class="sk" style="height:22px;width:70%" aria-label="Loading"></span>`; // the oracle is read a moment after the pools
  if (f.oracleAge !== null && f.oracleAge !== undefined) {
    const cls = f.oracleAge > maxAge * 0.85 ? "bad" : f.oracleAge > maxAge * 0.5 ? "warn" : "good";
    const pct = Math.min(100, (f.oracleAge / maxAge) * 100);
    age = `<span class="value ${cls}">${fmtAge(f.oracleAge)}</span>
      <span class="meter ${cls === "good" ? "" : cls}"><i style="--w:${pct.toFixed(0)}%"></i></span>
      <span class="sub">max ${Math.round(maxAge / 60)} min ${tip("LimeFX refuses to trade on an oracle price older than this.")}</span>`;
  }
  const base = Number(f.params.base_fee_bps), max = Number(f.params.max_fee_bps);
  const feePct = f.feeBps !== undefined && max > base ? Math.max(4, ((f.feeBps - base) / (max - base)) * 100) : 4;
  const status = f.paused
    ? `<span class="tag bad">paused</span>`
    : f.quoteError ? `<span class="tag bad">trading blocked</span>` : "";
  const note = f.paused
    ? callout("bad", "LimeFX is paused by its admin. Withdrawals still work.")
    : f.quoteError
      ? callout("bad", `Trading is blocked right now: ${esc(f.quoteError)}`)
      : "";
  return `<article class="card fx">
    <div class="fx-title">
      ${pairAvatar(tok(f.tokenA), tok(f.tokenB), "lg")}
      <div><h2>LimeFX · ${a} / ${b}</h2><span class="sub">Oracle-anchored stablecoin pool ${tip("It re-centres on the oracle's EUR/USD rate on every trade, so it always quotes the real exchange rate (minus the fee). A plain x·y=k pool only moves when arbitrageurs trade against it, and its LPs pay for that.")}</span></div>
      <span class="tags">${youBadge(f)}${aprTag(f)}${status}</span>
    </div>
    
    <div class="stats">
      <div class="stat"><span class="label">Price ${tip("LimeFX takes its price from the EUR/USD oracle, not from its reserves. The reserves only decide how far a large trade moves away from it.")}</span><span class="value xl">${f.oraclePrice ? fmtPrice(f.oraclePrice) : "–"}</span><span class="sub">${f.oraclePrice ? `${b} per 1 ${a}` : esc(f.oracleError ?? "no price")}</span></div>
      <div class="stat"><span class="label">Oracle updated</span>${age}</div>
      <div class="stat"><span class="label">Current fee ${tip("Dynamic: base fee plus surcharges while the oracle rate is moving or getting old. That protects LPs from traders who know the real rate before the oracle does.")}</span>
        <span class="value">${f.feeBps !== undefined ? fmtBps(f.feeBps) : "–"}</span>
        <span class="meter lime"><i style="--w:${feePct.toFixed(0)}%"></i></span>
        <span class="sub">range ${(base / 100).toFixed(2)}–${fmtBps(max)}</span></div>
    </div>
    <dl class="rows">
      <dt>TVL</dt><dd>${fmtTvl(tvl.get(f.id))}</dd>
      <dt>Reserves</dt><dd>${amt(f.reserveA, f.tokenA)}<small>${amt(f.reserveB, f.tokenB)}</small></dd>
      ${poolFeeRows(f)}
    </dl>
    <details class="fx-more"${fxMoreOpen ? " open" : ""}><summary>Pool details ${icon.chevron}</summary>
    <dl class="rows">
      <dt>Amp ${tip("Virtual liquidity multiplier: how much deeper than a plain pool LimeFX feels near the oracle price.")}</dt><dd>${f.params.amp}×</dd>
      <dt>Safety band ${tip("LimeFX refuses to trade if the oracle reports a price outside this range.")}</dt><dd>${fmtPrice(f.band[0])} – ${fmtPrice(f.band[1])} <small>${b} per ${a}</small></dd>
      <dt>Circuit breaker ${tip("If the latest price jumps more than this from the recent average, trading pauses.")}</dt><dd>${fmtBps(f.params.max_dev_bps)} jump</dd>
    </dl>
    </details>
    ${note}
    <div class="fx-foot">
      <span class="actions" style="display:flex;gap:8px">
        <button class="btn btn-ghost btn-sm" data-fx-trade="${f.tokenA},${f.tokenB}">Trade</button>
        <button class="btn btn-ghost btn-sm" data-fx-provide="${f.id}">Add liquidity</button>
      </span>
    </div>
  </article>`;
}

document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-fx-trade],[data-fx-provide]");
  if (!b || !app) return;
  if (b.dataset.fxTrade) app.trade(...b.dataset.fxTrade.split(","));
  else app.provide(b.dataset.fxProvide);
});
