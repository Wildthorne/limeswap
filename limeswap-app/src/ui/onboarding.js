// "Get test tokens" panel: takes a brand-new wallet from zero to tradable in three steps
// (Friendbot → trustlines in one signature → faucet claim). Opens by itself when a connected
// account still needs one of them; the header button and "Get test tokens" links reopen it.
import { faucetClaimCall, onboardingState, tokenById } from "../dex.js";
import { esc, fmtAmount } from "../format.js";
import { $, callout, icon, runTx, setHtml, successCard, tip, toast, tokenAvatar } from "./dom.js";

const WALLET_URL = "https://varialwallet.com/"; // freighter.app 301-redirects here (checked Nov 6, 2026)

let app;
let st = null; // onboardingState() for `forUser`, or { error }
let forUser = null;
let loading = false;
let busy = false;
let open = false;
let dismissed = false; // closed by the visitor: don't pop up again on its own this visit
let skew = 0; // chain clock − this computer's clock (s), for the claim countdown
let epoch = 0; // bumped by every successful action: a re-read started before it is out of date

export function init(a) {
  app = a;
  const available = Boolean(app.chain.config.friendbot || app.chain.config.faucet);
  // With a wallet, wait for the account check before showing the chip (no flash-then-vanish in the header).
  $("get-tokens").hidden = !available || Boolean(app.signer);
  if (!available) return;
  $("get-tokens").onclick = () => show();
  document.addEventListener("click", (e) => {
    if (e.target.closest("[data-onboard]")) { e.preventDefault(); show(); }
  });
  $("onboard").addEventListener("click", onAction);
  // A new account (connect, or the dev signer at start-up) gets a fresh check.
  app.onChange(() => (app.signer?.address ?? null) !== forUser && load());
  setInterval(() => open && !busy && render(), 30_000); // keep the countdown current
  load();
}

/** Open the panel (header button, "Get test tokens" links). */
export function show() {
  open = true;
  dismissed = false;
  render();
  $("onboard").scrollIntoView({ behavior: "smooth", block: "start" });
  if (app.signer && !st && !loading) load();
}

function hide() {
  open = false;
  dismissed = true;
  render();
}

const chainNow = () => Date.now() / 1000 + skew;
const claimable = () => Boolean(st?.faucet && st.faucet.nextClaim <= chainNow());
const needsHelp = () => Boolean(st && !st.error && (!st.funded || st.missing?.length !== 0 || claimable()));

async function load() {
  const user = app.signer?.address ?? null;
  forUser = user;
  if (!user) {
    st = null;
    return render();
  }
  loading = true;
  if (!st) render();
  const my = epoch;
  try {
    const s = await onboardingState(app.chain, app.tokens, user);
    if (forUser !== user || my !== epoch) return; // another account, or an action landed meanwhile
    st = s;
    if (s.faucet?.now) skew = s.faucet.now - Date.now() / 1000;
  } catch (e) {
    if (forUser !== user || my !== epoch) return;
    st = { error: e.message };
  }
  loading = false;
  if (!dismissed && needsHelp()) open = true;
  // Header chip: there while something is left to do (or a daily claim is ready); gone once you're all set.
  $("get-tokens").hidden = Boolean(st && !st.error && !needsHelp());
  render();
}

// ---------- Rendering ----------

const sym = (id) => esc(tokenById(app.tokens, id).symbol);
const dripText = () => (st?.faucet?.drips ?? []).map((d) => `${fmtAmount(d.amount, tokenById(app.tokens, d.token).decimals)} ${sym(d.token)}`).join(" + ");
const dripSymbols = () => (st?.faucet?.drips ?? []).map((d) => sym(d.token)).join(", ");

// Step glyphs: a drop of XLM, two linked rings (opt in), a lime wedge (the faucet).
const GLYPH = {
  drop: `<svg viewBox="0 0 24 24"><path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11Z" /></svg>`,
  link: `<svg viewBox="0 0 24 24"><circle cx="9" cy="12" r="5" /><circle cx="15" cy="12" r="5" /></svg>`,
  wedge: `<svg viewBox="0 0 24 24"><path d="M3 7a9 9 0 0 0 18 0Z" /><path d="M12 7v9M7.5 7l4.5 9M16.5 7 12 16" /></svg>`,
};

/** Token chips for the opt-in step. */
const chips = () => `<span class="ob-chips">${(st.missing?.length ? st.missing.map((m) => m.token) : (st.faucet?.drips ?? []).map((d) => tokenById(app.tokens, d.token)))
  .map((t) => `<span>${tokenAvatar(t, "sm")}${esc(t.symbol)}</span>`).join("")}</span>`;

/** A glass of lime juice, filled a third per finished step. */
const glass = (level) => `<svg class="glass" viewBox="0 0 46 64" role="img" aria-label="${level} of 3 steps done">
  <defs><clipPath id="glass-in"><path d="M6 5h34l-4.4 52.5a2 2 0 0 1-2 1.8H12.4a2 2 0 0 1-2-1.8Z" /></clipPath></defs>
  <g clip-path="url(#glass-in)"><rect class="juice" x="0" y="${64 - Math.max(0.08, level / 3) * 59}" width="46" height="64" fill="#c6f432" />
  ${level ? `<circle cx="17" cy="52" r="2.2" fill="#f3f0d8" opacity=".8" /><circle cx="28" cy="46" r="1.6" fill="#f3f0d8" opacity=".8" />` : ""}</g>
  <path d="M3 3h40l-5 55.5a4 4 0 0 1-4 3.5H12a4 4 0 0 1-4-3.5Z" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round" opacity=".55" />
</svg>`;

function until(seconds) {
  const minutes = Math.max(1, Math.ceil(seconds / 60)); // round up: never promise a claim too early
  const h = Math.floor(minutes / 60), m = minutes % 60;
  return h ? `${h} h${m ? ` ${m} min` : ""}` : `${m} min`;
}

function render() {
  const section = $("onboard");
  section.hidden = !open;
  if (!open || busy) return;
  const level = !st || st.error ? 0 : [st.funded, st.funded && st.missing?.length === 0, st.faucet && !claimable()].filter(Boolean).length;
  const head = `<div class="card-head">
      ${glass(level)}
      <div style="flex:1;min-width:0"><h2 id="onboard-title">Fill up on test tokens</h2>
      <p class="sub">Three quick sips and you're trading.</p></div>
      <button class="icon-btn" data-act="close" aria-label="Close the test tokens panel">${icon.close}</button>
    </div>`;

  const step = (glyph, state, title, text, action) => `<li class="ob-step ${state}">
      <span class="ob-num" aria-hidden="true">${state === "done" ? icon.check : glyph}</span>
      <div class="ob-body"><strong>${state === "done" ? `<span class="sr-only">Done: </span>` : ""}${title}</strong><p class="caption">${text}</p></div>
      <div class="ob-act">${action}</div>
    </li>`;
  if (!app.signer) {
    return setHtml("onboard-body", `${head}
      ${callout("zest", `Connect a wallet to start. No wallet? Get <a href="${WALLET_URL}" target="_blank" rel="noopener">Varial ${icon.external}</a> (formerly Freighter) and switch it to <strong>Testnet</strong>.`)}
      <ol class="ob-steps">${step(GLYPH.drop, "todo", "Create your Testnet account", "Free test XLM from Friendbot.", "")}${step(GLYPH.link, "todo", "Say yes to your tokens", "One signature for LEUR, LUSD and LIME.", "")}${step(GLYPH.wedge, "todo", "Grab your daily squeeze", "Free test tokens, once a day.", "")}</ol>`);
  }
  if (loading && !st) {
    return setHtml("onboard-body", `${head}<div class="ob-steps"><span class="sk sk-row"></span><span class="sk sk-row"></span><span class="sk sk-row"></span></div>`);
  }
  if (st?.error) {
    return setHtml("onboard-body", `${head}${callout("bad", `Couldn't check your account: ${esc(st.error)}`)}<button class="btn btn-ghost btn-sm" data-act="retry">Try again</button>`);
  }

  const funded = st.funded;
  const checking = funded && st.missing === null; // just funded: re-reading which trustlines are missing
  const trusted = funded && !checking && !st.missing.length;
  const claimed = Boolean(st.faucet) && !claimable();
  const hasFaucet = Boolean(st.faucet);
  const state = (done, ready) => (done ? "done" : ready ? "current" : "todo");
  const doneTag = () => ""; // the tick in the step's bubble says it

  const missingSyms = (st.missing ?? []).map((m) => esc(m.token.symbol)).join(", ");
  const trustCount = st.missing?.length ?? 0;
  const steps = [
    step(GLYPH.drop, state(funded, true), funded ? "Account created" : "Create your Testnet account",
      "Friendbot, Testnet's free faucet, sends XLM so your account exists and can pay fees.",
      funded ? doneTag("Funded") : `<button class="btn btn-lime btn-sm" data-act="fund">Fund my account</button>`),
    step(GLYPH.link, state(trusted, funded), trusted ? "Tokens welcomed" : "Say yes to your tokens",
      `One signature lets your account hold ${trustCount ? missingSyms : dripSymbols() || "them"}. ${tip("Stellar accounts opt in to each token (a trustline) to keep spam out. Each one sets aside 0.5 XLM, which you get back if you remove it.")}${trusted ? "" : chips()}`,
      trusted ? doneTag("Done") : checking ? `<button class="btn btn-lime btn-sm" disabled><span class="spin" aria-hidden="true"></span> Checking…</button>`
        : `<button class="btn btn-lime btn-sm" data-act="trust"${funded ? "" : " disabled"}>${trustCount === 1 ? `Add ${missingSyms}` : trustCount === 3 ? "Add all three" : trustCount ? `Add all ${trustCount}` : "Add trustlines"}</button>`),
  ];
  if (hasFaucet) {
    const wait = st.faucet.nextClaim - chainNow();
    const when = new Date((st.faucet.nextClaim - skew) * 1000);
    const nextText = claimed ? ` Next one in <strong>${until(wait)}</strong> (${esc(when.toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" }))}).` : "";
    steps.push(step(GLYPH.wedge, state(claimed, trusted), "Grab your daily squeeze",
      `<strong>${dripText()}</strong>, once a day.${nextText}`,
      claimed ? doneTag("Claimed") : `<button class="btn btn-lime btn-sm" data-act="claim"${trusted ? "" : " disabled"}>Claim tokens</button>`));
  }
  const allDone = funded && trusted && (!hasFaucet || claimed);
  if (allDone) {
    const next = hasFaucet ? ` · next daily claim in <strong>${until(st.faucet.nextClaim - chainNow())}</strong>` : "";
    return setHtml("onboard-body", `${head}<p class="ob-done">All set${next}</p><button class="btn btn-lime btn-lg" data-act="swap">Start swapping</button>`);
  }
  setHtml("onboard-body", `${head}<ol class="ob-steps">${steps.join("")}</ol>`);
}

// ---------- Actions ----------

async function onAction(e) {
  const b = e.target.closest("[data-act]");
  if (!b || busy) return;
  const act = b.dataset.act;
  if (act === "close") return hide();
  if (act === "connect") return app.connect();
  if (act === "retry") return load();
  if (act === "swap") {
    hide();
    return app.trade(app.chain.config.tokens.leur, app.chain.config.tokens.lusd);
  }
  const status = $("onboard-status");
  busy = true;
  let ok = false;
  try {
    if (act === "fund") ok = await fund(b, status);
    if (act === "trust") {
      const assets = st.missing.map((m) => m.asset), names = st.missing.map((m) => m.token.symbol).join(", ");
      ok = await runTx(app, b, status, (onStatus) => app.chain.addTrustlines(app.signer, assets, onStatus), () => `Your account now accepts ${names}.`, { kicker: "You're in" });
    }
    if (act === "claim") {
      const what = dripText().replace(/<[^>]+>/g, "");
      ok = await runTx(app, b, status, faucetClaimCall(app.chain, app.signer.address), () => `${what} landed in your wallet.`, { kicker: "Squeezed!" });
    }
  } finally {
    busy = false;
  }
  if (!ok) return render();
  epoch++;
  // Advance the steps at once from what just succeeded (a full re-read takes 15–25 s on Testnet,
  // and meanwhile the finished step's button invited a second click), then confirm on-chain.
  if (act === "fund") Object.assign(st, { funded: true, missing: null });
  if (act === "trust") st.missing = [];
  if (act === "claim" && st.faucet) st.faucet.nextClaim = Math.floor(chainNow()) + 24 * 3600;
  render();
  app.changed(); // Swap and Liquidity re-read balances now, not at the next background refresh
  await load();
}

async function fund(button, status) {
  const label = button.innerHTML;
  button.disabled = true;
  button.innerHTML = `<span class="spin" aria-hidden="true"></span> Funding…`;
  status.innerHTML = `<p class="caption">Asking Friendbot for test XLM (a few seconds)…</p>`;
  try {
    await app.chain.fundWithFriendbot(app.signer.address);
    status.innerHTML = successCard("Account created", null, "Your Testnet account exists now and holds free test XLM.");
    toast("Account funded with test XLM", { ok: true });
    app.refresh(true).catch(() => {});
    return true;
  } catch (e) {
    status.innerHTML = callout("bad", `Didn't go through. ${esc(e.message)}`);
    return false;
  } finally {
    button.innerHTML = label;
    button.disabled = false;
  }
}
