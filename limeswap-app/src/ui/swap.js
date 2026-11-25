// Swap tab: quote every route, pick the best, explain it, execute it.
import { balanceOf, findRoutes, minOut, swapCall, tokenById, trustStatus } from "../dex.js";
import { esc, fmtAge, fmtAmount, fmtPct, fmtPrice, parseAmount } from "../format.js";
import { $, callout, debounce, icon, openPicker, runTx, setHtml, tip, tokenAvatar } from "./dom.js";
import { kycCallout, loadKyc, verify } from "./kyc.js";
import { remember, remembered } from "./balances.js";

let app;
let inId, outId; // selected tokens
let routes = [];
let quotedFor = null; // { amountIn, tokenIn, tokenOut } of the routes on screen
let phase = "noamount"; // same | noamount | loading | quoting | done
let busy = false;
let seq = 0; // ignore stale quote results
let quoting = false;
let quoteOpen = false, compareOpen = false; // remembered across re-renders
let goAction = null; // what the big button does: "swap" | "connect" | null
let lastSwap = null; // { tokenIn, tokenOut, amountIn, label } of the swap in the "Confirmed" box
const balances = new Map(); // token id -> balance, for the picker

export function init(a) {
  app = a;
  inId = app.chain.config.tokens.leur;
  outId = app.chain.config.tokens.lusd;
  $("swap-amount").value = "10";
  renderTokens();
  const requote = debounce(quote, 400);
  $("swap-amount").oninput = () => {
    clearResult();
    requote();
  };
  $("swap-in-btn").onclick = () => pickToken("in");
  $("swap-out-btn").onclick = () => pickToken("out");
  $("swap-flip").onclick = () => {
    [inId, outId] = [outId, inId];
    clearResult();
    renderTokens();
    quote();
  };
  $("swap-go").onclick = () => (goAction === "connect" ? app.connect() : goAction === "swap" && execute());
  $("swap-notes").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-kyc]");
    if (!btn || busy) return;
    busy = true;
    const ok = await verify(app, btn, $("swap-status"), tokenById(app.tokens, btn.dataset.kyc));
    busy = false;
    if (ok) balances.clear();
    quote();
  });

  // Slippage popover.
  const pop = $("settings-pop"), gear = $("swap-settings");
  const setPop = (open) => { pop.hidden = !open; gear.setAttribute("aria-expanded", String(open)); };
  gear.onclick = (e) => { e.stopPropagation(); setPop(pop.hidden); };
  document.addEventListener("click", (e) => !pop.hidden && !e.target.closest(".pop-wrap") && setPop(false));
  document.addEventListener("keydown", (e) => e.key === "Escape" && !pop.hidden && (setPop(false), gear.focus()));
  $("slip-chips").onclick = (e) => {
    const b = e.target.closest("[data-slip]");
    if (b) { $("slippage").value = b.dataset.slip; renderSlip(); renderSummary(); }
  };
  $("slippage").oninput = () => { renderSlip(); renderSummary(); };
  renderSlip();

  // Remember whether the receipt / route comparison is expanded.
  const remember = (e) => (e.target.classList.contains("compare") ? (compareOpen = e.target.open) : (quoteOpen = e.target.open));
  $("swap-quote").addEventListener("toggle", remember, true);
  $("routes").addEventListener("toggle", remember, true);

  // Prices change: re-quote quietly on every refresh (unless a quote or transaction is in flight).
  // A wallet that just connected (or changed) re-reads at once, even while a quote is in flight.
  app.onChange(() => {
    if (busy) return;
    if ((app.signer?.address ?? null) !== account.user) quote(true);
    else if (!quoting) quote(true);
  });
}

/** Called from the Pools tab ("Trade"). */
export function setPair(a, b) {
  inId = a;
  outId = b;
  clearResult();
  renderTokens();
  quote();
}

const tIn = () => tokenById(app.tokens, inId);
const tOut = () => tokenById(app.tokens, outId);
const slippageBps = () => {
  const v = Number($("slippage").value);
  return $("slippage").value.trim() !== "" && Number.isFinite(v) && v >= 0 && v <= 50 ? Math.round(v * 100) : null;
};

function renderSlip() {
  const v = $("slippage").value.trim();
  for (const b of document.querySelectorAll("#slip-chips [data-slip]")) b.classList.toggle("on", b.dataset.slip === v);
  const label = $("slip-label");
  label.textContent = slippageBps() === null ? "slippage?" : `${v}%`;
  label.classList.toggle("custom", v !== "0.5");
  label.hidden = v === "0.5"; // like Uniswap: only show slippage when you changed it
}

function renderTokens() {
  for (const [side, t] of [["in", tIn()], ["out", tOut()]]) {
    $(`swap-${side}-btn`).innerHTML = `${tokenAvatar(t)}<span>${esc(t.symbol)}</span>${icon.chevron}`;
    $(`swap-${side}-btn`).setAttribute("aria-label", `${side === "in" ? "Pay with" : "Receive"} ${t.symbol}, change token`);
    $(`swap-${side}-note`).textContent = ""; // token descriptions live in the token picker
  }
}

function pickToken(side) {
  const current = side === "in" ? inId : outId;
  const items = () => app.tokens.map((t) => ({
    id: t.id,
    current: t.id === current,
    search: `${t.symbol} ${t.note} ${t.key}`,
    html: `${tokenAvatar(t, "lg")}<span class="t"><strong>${esc(t.symbol)}${t.key === "lfund" ? `<span class="tag warn">regulated</span>` : t.key === "limeContract" ? `<span class="tag">contract token</span>` : ""}</strong><span>${esc(t.note)}</span></span>`,
    right: !app.signer ? "" : balances.has(t.id) ? `${fmtAmount(balances.get(t.id), t.decimals, 2)}<small>balance</small>` : `<span class="sk" style="width:56px;height:12px"></span>`,
  }));
  const picker = openPicker({
    title: side === "in" ? "Pay with" : "Receive",
    items,
    placeholder: "Search symbol or name",
    onPick: (id) => {
      const other = side === "in" ? outId : inId;
      if (id === other) [inId, outId] = [outId, inId]; // picking the other side's token flips them
      else if (side === "in") inId = id;
      else outId = id;
      clearResult();
      renderTokens();
      quote();
    },
  });
  if (app.signer) {
    const user = app.signer.address;
    // Last-known balances first (instant), then fresh ones.
    for (const t of app.tokens) {
      const c = remembered(app.chain, user, t.id);
      if (!balances.has(t.id) && c) balances.set(t.id, c.balance);
    }
    picker.refresh();
    Promise.all(app.tokens.map(async (t) => {
      const v = await balanceOf(app.chain, t.id, user);
      balances.set(t.id, v);
      remember(app.chain, user, t.id, { balance: v });
    })).then(picker.refresh);
  }
}

const NO_ACCOUNT = { user: null, inId: null, outId: null, balanceIn: null, balanceOut: null, trustIn: "n/a", trustOut: "n/a", kycIn: null, kycOut: null };
let account = NO_ACCOUNT;

/** The account panel for this wallet and pair from last-known values (instant), or "loading". */
function seedAccount(user, a, b) {
  const ci = remembered(app.chain, user, a.id), co = remembered(app.chain, user, b.id);
  account = ci && co
    ? { user, inId: a.id, outId: b.id, balanceIn: ci.balance, balanceOut: co.balance, trustIn: ci.trust, trustOut: co.trust, kycIn: ci.kyc, kycOut: co.kyc }
    : { ...NO_ACCOUNT, user };
}

async function quote(quiet = false) {
  const my = ++seq;
  quoting = true;
  try {
    await doQuote(my, quiet);
  } finally {
    if (my === seq) quoting = false;
  }
}

async function doQuote(my, quiet) {
  const a = tIn(), b = tOut();
  const amountIn = parseAmount($("swap-amount").value, a.decimals);
  const pre = a.id === b.id ? "same" : !amountIn ? "noamount" : !app.pools.length ? "loading" : null;
  if (!quiet) {
    routes = [];
    quotedFor = null;
    phase = pre ?? "quoting";
    renderSummary();
  }
  const user = app.signer?.address ?? null;
  if (!user) account = NO_ACCOUNT;
  else if (account.user !== user || account.inId !== a.id || account.outId !== b.id) {
    // New wallet or pair: show last-known balances (or "loading") now, not after the reads.
    seedAccount(user, a, b);
    renderSummary();
  }
  // The quote and the account reads go out together; balances show as soon as they're back.
  const routesP = pre ? null : findRoutes(app.chain, { pools: app.pools, fx: app.fx, tokenIn: a.id, tokenOut: b.id, amountIn });
  routesP?.catch(() => {}); // awaited below; this only avoids an "unhandled" warning meanwhile
  if (user) {
    const [bi, bo, ti, to, ki, ko] = await Promise.all([
      balanceOf(app.chain, a.id, user), balanceOf(app.chain, b.id, user),
      trustStatus(app.chain, a, user), trustStatus(app.chain, b, user),
      loadKyc(app, a, user).catch(() => null), loadKyc(app, b, user).catch(() => null),
    ]);
    if (my !== seq) return;
    account = { user, inId: a.id, outId: b.id, balanceIn: bi, balanceOut: bo, trustIn: ti, trustOut: to, kycIn: ki, kycOut: ko };
    remember(app.chain, user, a.id, { balance: bi, trust: ti, kyc: ki });
    remember(app.chain, user, b.id, { balance: bo, trust: to, kyc: ko });
    renderSummary();
  }
  if (pre) {
    phase = pre;
  } else {
    const found = await routesP;
    if (my !== seq) return; // a newer quote started meanwhile
    routes = found;
    quotedFor = { amountIn, tokenIn: a.id, tokenOut: b.id };
    phase = "done";
  }
  if (my === seq) renderSummary();
}

const impactClass = (x) => (x > 0.05 ? "bad" : x > 0.01 ? "warn" : "");
const venueName = (h) => (h.type === "fx" ? "LimeFX" : `LimeSwap ${h.feeBps / 100}%`);

// The route sits inside the swap details (like Uniswap's "order routing"); only when every route
// failed does the comparison show on its own, open, so the reasons are visible.
function renderRoutes() {
  const failed = phase === "done" && routes.length && !routes[0].ok;
  setHtml("routes", failed ? routeBlock() : "");
}

function routeBlock() {
  const b = tOut();
  const best = routes[0].ok ? routes[0] : null;
  let path = "";
  if (best) {
    const parts = [];
    best.hops.forEach((h, i) => {
      const t = tokenById(app.tokens, best.tokens[i]);
      parts.push(`<span class="hop">${tokenAvatar(t, "sm")}${esc(t.symbol)}</span><span class="arrow" aria-hidden="true">→</span><span class="venue${h.type === "fx" ? " fx" : ""}">${venueName(h)}</span><span class="arrow" aria-hidden="true">→</span>`);
    });
    const last = tokenById(app.tokens, best.tokens.at(-1));
    parts.push(`<span class="hop">${tokenAvatar(last, "sm")}${esc(last.symbol)}</span>`);
    path = `<div class="path" aria-label="Best route: ${esc(best.label)}">${parts.join("")}</div>`;
  }
  const items = routes.map((r, i) => r.ok
    ? `<li class="${i === 0 ? "best" : ""}"><span class="name">${esc(r.label)}${i === 0 ? `<span class="tag lime">Best</span>` : ""}</span>
        <span class="out">${fmtAmount(r.amountOut, b.decimals)} ${esc(b.symbol)}</span>
        <span class="meta">fee ${fmtPct(r.feeFraction)} · price impact <span class="${impactClass(r.priceImpact)}">${fmtPct(r.priceImpact)}</span></span></li>`
    : `<li class="failed"><span class="name">${esc(r.label)}<span class="tag bad">unavailable</span></span><span class="out">–</span><span class="meta">${esc(r.error)}</span></li>`);
  const open = compareOpen || !best;
  return `<div class="route">
    <div class="route-head"><span>Route ${tip("We quote every direct pool (all LimeSwap fee tiers and LimeFX) and every route of up to 4 pools through other tokens, mixing LimeSwap and LimeFX hops, then pick the one that pays you the most.")}</span></div>
    ${path}
    <details class="compare"${open ? " open" : ""}><summary>Compare ${routes.length} route${routes.length === 1 ? "" : "s"} ${icon.chevron}</summary><ul class="route-list">${items.join("")}</ul></details>
  </div>`;
}

function renderSummary() {
  const a = tIn(), b = tOut();
  const best = phase === "done" && routes[0]?.ok ? routes[0] : null;
  const notes = [];
  let blocker = null;
  const mine = app.signer && account.user === app.signer.address && account.inId === a.id && account.outId === b.id;
  const over = mine && quotedFor && account.balanceIn !== null && quotedFor.amountIn > account.balanceIn;

  // Balances under the panels.
  if (app.signer) {
    $("swap-in-bal").innerHTML = mine ? `Balance ${fmtAmount(account.balanceIn, a.decimals)} <button class="link-btn" id="swap-max" aria-label="Use your whole ${esc(a.symbol)} balance">Max</button>${over ? ` · <button class="link-btn" data-onboard>Get test tokens</button>` : ""}` : `<span class="sk" style="width:90px;height:12px"></span>`;
    $("swap-out-bal").textContent = mine ? `Balance ${fmtAmount(account.balanceOut, b.decimals)}` : "";
    if ($("swap-max")) $("swap-max").onclick = () => {
      $("swap-amount").value = fmtAmount(account.balanceIn, a.decimals, a.decimals).replace(/,/g, "");
      clearResult();
      quote();
    };
  } else {
    $("swap-in-bal").textContent = $("swap-out-bal").textContent = "";
  }

  // The big output number.
  const out = $("swap-out-amount");
  if (phase === "quoting") setHtml(out, `<span class="sk sk-num"></span>`);
  else setHtml(out, best ? fmtAmount(best.amountOut, b.decimals) : "0");
  out.classList.toggle("empty", !best);

  $("swap-amount").classList.toggle("over", Boolean(over));

  // What's stopping a swap, in order. The first one becomes the button label.
  const block = (label, note) => {
    blocker ??= label;
    if (note) notes.push(note);
  };
  if (phase === "same") block("Pick two different tokens", callout("info", "Pick two different tokens."));
  else if (phase === "noamount") block("Enter an amount");
  else if (phase === "loading") block("Loading pools…");
  else if (phase === "quoting") block("Finding the best route…");
  else if (!routes.length) block(`No route from ${a.symbol} to ${b.symbol}`);
  else if (!best) block("No route available right now");

  if (app.signer && best && !mine) block("Loading your balances…");
  if (app.signer && best && mine) {
    if (over) block(`Insufficient ${a.symbol}`);
    // A regulated token with a demo KYC desk: verifying adds the trustline and the approval.
    const kycOut = kycCallout(b, account.trustOut, account.kycOut), kycIn = kycCallout(a, account.trustIn, account.kycIn);
    const kyc = kycOut ?? kycIn;
    if (kyc) block(`Verify for ${(kycOut ? b : a).symbol} first`, kyc);
    else if (account.trustOut === "missing") block(`Add a ${b.symbol} trustline first`, callout("bad", `Your account hasn't opted in to ${esc(b.symbol)} yet, so it can't receive it. <button class="link-btn" data-onboard>Add it with Get test tokens</button> ${tip("On Stellar an account must opt in (a trustline) before it can hold a classic asset: an anti-spam rule. You can also add it in your wallet under Manage assets.")}`));
    if (!kyc && (account.trustOut === "frozen" || account.trustIn === "frozen")) {
      const t = account.trustOut === "frozen" ? b : a;
      block(`${t.symbol} not authorized`, callout("bad", `The issuer of ${esc(t.symbol)} hasn't authorized (or has frozen) your trustline, so you can't ${t === b ? "receive" : "send"} it.`));
    }
  }

  const slip = slippageBps();
  if (slip === null) block("Set a valid max slippage", callout("bad", "Max slippage must be 0–50%. Change it under the gear."));

  if (best && slip !== null) {
    const min = minOut(best.amountOut, slip);
    const rate = best.execPrice * 10 ** (a.decimals - b.decimals);
    const A = esc(a.symbol), B = esc(b.symbol);
    setHtml("swap-quote", `<details class="quote"${quoteOpen ? " open" : ""}>
      <summary><span class="rate">1 ${A} = ${fmtPrice(rate)} ${B}</span><span class="meta">fee ${fmtPct(best.feeFraction)} · <span class="${impactClass(best.priceImpact)}">impact ${fmtPct(best.priceImpact)}</span>${icon.chevron}</span></summary>
      <div class="body">
        ${routeBlock()}
        <dl class="rows">
          <dt>${best.venue === "fx" ? `Oracle price ${tip(`LimeFX prices against the oracle's EUR/USD rate, not its own reserves, and refuses prices older than ${Math.round(Number(app.fx?.params?.max_age ?? 360) / 60)} min. Its fee is dynamic: higher while the rate is moving or the price is getting old.`)}` : `Pool price now ${tip("The pools' current reserve ratio along the route, before fees and your own trade.")}`}</dt><dd>1 ${A} = ${fmtPrice(best.mid)} ${B}${best.venue === "fx" && app.fx?.oracleAge != null ? `<small>updated ${fmtAge(app.fx.oracleAge)}</small>` : ""}</dd>
          <dt>Fee ${tip("Paid to the liquidity providers of the pools on the route.")}</dt><dd>${fmtPct(best.feeFraction)}</dd>
          <dt>Price impact ${tip("How much your own trade moves the price (the fee is shown separately). Under 1% is normal; above 5% means the pool is small for this amount: try a smaller trade.")}</dt><dd class="${impactClass(best.priceImpact)}">${fmtPct(best.priceImpact)}</dd>
          <dt>Minimum received <small class="muted">(${(slip / 100).toFixed(1)}% slippage)</small> ${tip(`If the price moves more than ${(slip / 100).toFixed(2)}% before your transaction lands, the contract cancels it and you keep your ${a.symbol}.`)}</dt><dd>${fmtAmount(min, b.decimals)} ${B}</dd>
        </dl>
      </div>
    </details>`);
    // A plain pool for the LimeFX pair can drift from the real rate; say so when it does.
    const fx = app.fx;
    if (best.venue === "limeswap" && fx?.oraclePrice && [fx.tokenA, fx.tokenB].includes(a.id) && [fx.tokenA, fx.tokenB].includes(b.id)) {
      const oracle = a.id === fx.tokenA ? fx.oraclePrice : 1 / fx.oraclePrice;
      const gap = best.execPrice / oracle - 1;
      if (gap > 0.002) notes.push(callout("good", `This pool pays ${fmtPct(gap)} above the oracle rate: its price drifted and your trade nudges it back. ${tip("That's arbitrage, and the pool's LPs pay for it. LimeFX avoids this by following the oracle.")}`));
    }
    if (best.priceImpact > 0.05 && !blocker) notes.push(callout("bad", `High price impact: you'd lose ${fmtPct(best.priceImpact)} to the pool's curve. Try a smaller amount.`));
  } else {
    setHtml("swap-quote", "");
  }

  renderRoutes();
  setHtml("swap-notes", notes.length ? `<div class="stack">${notes.join("")}</div>` : "");
  markResult(best);

  if (busy) return; // runTx owns the button while a transaction is in flight
  const go = $("swap-go");
  goAction = !app.signer && !blocker ? "connect" : blocker ? null : "swap";
  go.textContent = goAction === "connect" ? "Connect wallet" : blocker ?? `Swap ${a.symbol} → ${b.symbol}`;
  go.disabled = !goAction;
  go.classList.toggle("danger", goAction === "swap" && best?.priceImpact > 0.05);
}

// The "Confirmed" box describes a swap that already happened, while the card above keeps re-quoting.
// Editing the form starts a new swap, so the old result goes; until then, the box says so whenever
// the quote on screen no longer matches the swap it describes: another route, or an output more than
// 0.1% away (e.g. your own trade moved the price).
function clearResult() {
  lastSwap = null;
  $("swap-status").innerHTML = "";
}

function markResult(best) {
  const box = $("swap-status").querySelector(".result .res-body");
  if (!box || !lastSwap || phase === "quoting") return;
  const same = best && quotedFor && best.label === lastSwap.label && quotedFor.amountIn === lastSwap.amountIn
    && quotedFor.tokenIn === lastSwap.tokenIn && quotedFor.tokenOut === lastSwap.tokenOut
    && Math.abs(Number(best.amountOut - lastSwap.amountOut)) <= Number(lastSwap.amountOut) / 1000; // within 0.1%
  box.querySelector(".kicker").textContent = same ? "Freshly squeezed" : "Your last swap";
  let note = box.querySelector(".fresh-note");
  if (!same && !note) {
    note = document.createElement("p");
    note.className = "caption fresh-note";
    note.textContent = "The quote above is a fresh one, for your next swap.";
    box.append(note);
  } else if (same && note) {
    note.remove();
  }
}

async function execute() {
  const best = routes[0];
  if (!best?.ok || !quotedFor || busy) return;
  const b = tOut();
  const min = minOut(best.amountOut, slippageBps());
  busy = true;
  lastSwap = null;
  const call = swapCall(app.chain, best, app.signer.address, quotedFor.amountIn, min, await app.chain.now());
  const a = tIn(), paid = fmtAmount(quotedFor.amountIn, a.decimals), amountIn = quotedFor.amountIn;
  const got = (res) => (Array.isArray(res) ? res.at(-1) : res);
  let received = null;
  const ok = await runTx(app, $("swap-go"), $("swap-status"), call,
    (res) => ((received = got(res)), `For ${paid} ${a.symbol}, via ${best.label}.`),
    { kicker: "Freshly squeezed", headline: (res) => `+${fmtAmount(got(res), b.decimals)} <small>${esc(b.symbol)}</small>` });
  if (ok) {
    lastSwap = { ...quotedFor, label: best.label, amountOut: best.amountOut };
    // Show the new balances at once from what the swap did; the re-read below confirms them
    // (and corrects the XLM fee when XLM was paid).
    const user = app.signer?.address;
    if (user && account.user === user && account.inId === a.id && account.outId === b.id) {
      if (account.balanceIn !== null) account.balanceIn -= amountIn;
      if (account.balanceOut !== null && received !== null) account.balanceOut += BigInt(received);
      remember(app.chain, user, a.id, { balance: account.balanceIn });
      remember(app.chain, user, b.id, { balance: account.balanceOut });
    }
  }
  busy = false;
  balances.clear();
  quote();
}
