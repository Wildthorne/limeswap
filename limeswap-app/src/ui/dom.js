// Small DOM helpers shared by the tabs: banner, token avatars, tooltips, picker sheet, toasts,
// and runTx (transaction progress → result).
import { esc } from "../format.js";

export const $ = (id) => document.getElementById(id);

/** Set innerHTML only when it changed (keeps focus, hover and open <details> stable across refreshes). */
export function setHtml(el, html) {
  if (typeof el === "string") el = $(el);
  if (el && el.dataset.html !== html) {
    el.innerHTML = html;
    el.dataset.html = html;
  }
}

let transient = false;
/** Message at the top of the page. Transient ones (network hiccups) clear on the next good refresh. */
export function banner(text, isTransient = false) {
  transient = isTransient;
  $("banner").hidden = !text;
  $("banner").textContent = text || "";
}
export const clearTransientBanner = () => transient && banner("");

// ---------- Small pieces of markup ----------

export const icon = {
  chevron: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>`,
  check: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 5 5 9-10" /></svg>`,
  copy: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h8" /></svg>`,
  search: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>`,
  close: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>`,
  external: `<svg viewBox="0 0 24 24" aria-hidden="true" style="width:13px;height:13px;vertical-align:-2px"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></svg>`,
};

// Test tokens have no logos: a coloured disc with a glyph, one fixed colour per token key.
const AVATARS = {
  xlm: ["✦", "#5b6b84"], limeClassic: ["L", "#a6e635", true], limeContract: ["L", "#4d7c0f"],
  lfund: ["F", "#d97706"], leur: ["€", "#2563eb"], lusd: ["$", "#16a34a"],
};
export function tokenAvatar(t, size = "") {
  const [glyph, colour, darkText] = AVATARS[t?.key] ?? [(t?.symbol ?? "?")[0], "#64748b"];
  return `<span class="tok ${size}${darkText ? " dark-text" : ""}" style="--c:${colour}" aria-hidden="true">${esc(glyph)}</span>`;
}
export const pairAvatar = (a, b, size = "") => `<span class="pair">${tokenAvatar(a, size)}${tokenAvatar(b, size)}</span>`;

/** "?" with an explanation on hover/focus (keyboard reachable). */
export const tip = (text) => `<span class="tip" tabindex="0" role="img" aria-label="${esc(text)}" data-tip="${esc(text)}">?</span>`;

// The "?" text shows in one floating bubble attached to the page (or the open sheet), never inside the
// card: boxes with overflow: hidden (swap details, LimeFX card, success cards) used to clip it. It opens
// below the "?" and flips above when there's no room; it never runs off the screen sideways.
let tipEl = null, tipFor = null;
function showTip(t) {
  tipEl ??= Object.assign(document.createElement("div"), { className: "tip-pop" });
  tipEl.setAttribute("role", "tooltip");
  tipEl.textContent = t.dataset.tip;
  (t.closest("dialog[open]") ?? document.body).append(tipEl);
  tipFor = t;
  tipEl.hidden = false;
  tipEl.style.maxWidth = `${Math.min(280, innerWidth - 24)}px`;
  tipEl.style.left = tipEl.style.top = "0px";
  const r = t.getBoundingClientRect(), b = tipEl.getBoundingClientRect();
  const below = r.bottom + 8, above = r.top - 8 - b.height;
  tipEl.style.top = `${below + b.height <= innerHeight - 8 || above < 8 ? below : above}px`;
  tipEl.style.left = `${Math.max(12, Math.min(r.left - 8, innerWidth - b.width - 12))}px`;
}
function hideTip() {
  if (tipEl) tipEl.hidden = true;
  tipFor = null;
}
document.addEventListener("mouseover", (e) => {
  const t = e.target.closest?.(".tip[data-tip]");
  if (t) { if (t !== tipFor) showTip(t); }
  else if (tipFor && document.activeElement !== tipFor) hideTip();
});
document.addEventListener("focusin", (e) => { const t = e.target.closest?.(".tip[data-tip]"); if (t) showTip(t); else hideTip(); });
document.addEventListener("focusout", (e) => e.target.closest?.(".tip") && hideTip());
document.addEventListener("keydown", (e) => e.key === "Escape" && hideTip());
addEventListener("scroll", hideTip, true);
addEventListener("resize", hideTip);

export const callout = (kind, html) => `<div class="callout ${kind}"><div>${html}</div></div>`;

/** The LimeSwap lime slice (pure CSS, see .lime-slice in style.css). Decorative. */
export const slice = (cls = "", style = "") => `<span class="lime-slice ${cls}"${style ? ` style="${style}"` : ""} aria-hidden="true"></span>`;

// Success burst: slice + tick + wedges and drops flying out (direction per piece).
const FLY = [[-38, -30], [40, -34], [-44, 14], [46, 20], [-12, -46], [14, 44], [30, -10], [-30, 36]];
/** Success card: burst, kicker ("Freshly squeezed"), optional big line (trusted HTML), sentence, extra HTML. */
export const successCard = (kicker, big, text, extra = "") =>
  `<div class="result" role="status">${burst()}<div class="res-body"><p class="kicker">${esc(kicker)}</p>${big ? `<p class="res-amount">${big}</p>` : ""}<p class="res-text">${esc(text)}</p>${extra ? `<p class="res-text">${extra}</p>` : ""}</div></div>`;
const burst = () => `<span class="burst" aria-hidden="true">${slice()}<span class="tick">${icon.check}</span>${FLY.map(([x, y]) => `<i style="--dx:${x}px;--dy:${y}px"></i>`).join("")}</span>`;

/** Copyable value (contract ID, address): shows `label`, copies `value`. */
export const copyBtn = (value, label = value) =>
  `<button class="copy" data-copy="${esc(value)}" title="Copy ${esc(value)}" aria-label="Copy ${esc(label)} (full ID)">${esc(label)}${icon.copy}</button>`;
document.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-copy]");
  if (!b) return;
  e.preventDefault();
  try {
    await navigator.clipboard.writeText(b.dataset.copy);
    toast("Copied to clipboard");
  } catch {
    toast("Couldn't copy (clipboard blocked)");
  }
});

// ---------- Toasts ----------

export function toast(html, { ok = false, ms = 6000 } = {}) {
  const el = document.createElement("div");
  el.className = "toast";
  el.innerHTML = `${ok ? slice() : ""}<div>${html}</div><button class="x" aria-label="Dismiss">×</button>`;
  el.querySelector(".x").onclick = () => el.remove();
  $("toasts").append(el);
  setTimeout(() => el.remove(), ms);
}

// ---------- Picker sheet (modal on desktop, bottom sheet on a phone) ----------

/**
 * Opens a list picker. items: [{ id, html (left/middle), right, search (text), current }].
 * `items` may be a function returning items (re-rendered by calling the returned refresh()).
 * Resolves nothing; calls onPick(id).
 */
export function openPicker({ title, intro = "", items, onPick, searchable = true, placeholder = "Search name or symbol", hero = false, listClass = "", footer = "", filter = null }) {
  const d = document.createElement("dialog");
  d.className = `sheet${hero ? " with-hero" : ""}`;
  d.setAttribute("aria-label", title);
  d.innerHTML = `${hero ? `<div class="sheet-hero" aria-hidden="true">${slice()}<span class="drop" style="left:34px;top:62px"></span><span class="drop" style="left:82px;top:34px;width:8px;height:8px"></span><span class="drop" style="left:62px;top:96px;width:7px;height:7px"></span></div>` : ""}
    <div class="sheet-head"><h2>${esc(title)}</h2><button class="icon-btn" data-close aria-label="Close">${icon.close}</button></div>
    ${searchable ? `<label class="sheet-search">${icon.search}<input type="search" placeholder="${esc(placeholder)}" aria-label="${esc(placeholder)}" /></label>` : ""}
    ${intro ? `<p class="caption sheet-intro">${intro}</p>` : ""}
    ${filter ? `<div class="sheet-filter"><button class="chip-btn" data-filter aria-pressed="${filter.on ? "true" : "false"}">${esc(filter.label)}</button></div>` : ""}
    <ul class="sheet-list ${listClass}" role="list"></ul>${footer ? `<div class="sheet-foot">${footer}</div>` : ""}`;
  document.body.append(d);
  const list = d.querySelector(".sheet-list");
  const input = d.querySelector("input");
  const render = () => {
    const q = (input?.value ?? "").trim().toLowerCase();
    const all = typeof items === "function" ? items() : items;
    const only = filter && d.querySelector("[data-filter]").getAttribute("aria-pressed") === "true";
    const shown = all.filter((it) => (!q || it.search.toLowerCase().includes(q)) && (!only || it[filter.key]));
    list.innerHTML = shown.map((it) => `<li><button data-id="${esc(it.id)}" ${it.current ? `aria-current="true"` : ""}>${it.html}<span class="r">${it.right ?? ""}</span></button></li>`).join("")
      || `<li class="sheet-empty">${slice()}<span>No juice here: nothing matches “${esc(q)}”.</span></li>`;
  };
  render();
  if (input) input.oninput = render;
  const chip = d.querySelector("[data-filter]");
  if (chip) chip.onclick = () => {
    const on = chip.getAttribute("aria-pressed") !== "true";
    chip.setAttribute("aria-pressed", String(on));
    chip.classList.toggle("on", on);
    filter.on = on;
    render();
  };
  chip?.classList.toggle("on", Boolean(filter?.on));
  list.onclick = (e) => {
    const b = e.target.closest("button[data-id]");
    if (!b) return;
    d.close();
    onPick(b.dataset.id);
  };
  d.querySelector("[data-close]").onclick = () => d.close();
  d.onclick = (e) => e.target === d && d.close(); // click on the backdrop
  d.onclose = () => d.remove();
  d.showModal();
  (input ?? list.querySelector("button"))?.focus();
  return { refresh: render };
}

// ---------- Transactions ----------

const STEPS = ["Prepare", "Sign", "Send", "Confirm"];
const stepOf = (msg) => (/^Preparing/.test(msg) ? 0 : /^Submitting/.test(msg) ? 2 : /^Waiting for the network/.test(msg) ? 3 : 1);
const stepsHtml = (active, msg) => `<ol class="steps" aria-label="Transaction progress">${STEPS.map((s, i) =>
  `<li class="${i < active ? "done" : i === active ? "active" : ""}">${s}</li>`).join("")}</ol><p class="caption">${esc(msg)}</p>`;

/**
 * Run a transaction from a button: disables it, shows progress steps, then the result.
 * `call` is a contract call [contractId, method, args], or a function (onStatus) => { hash, result }
 * for transactions built elsewhere (e.g. chain.addTrustlines).
 * `opts.kicker` names the success ("Freshly squeezed"); `opts.headline(result)` returns trusted HTML for
 * the big line (e.g. "+11.22 LUSD"), with `describe(result)` as the plain sentence under it.
 */
export async function runTx(app, button, statusEl, call, describe, { kicker = "Done", headline = null } = {}) {
  if (!app.signer) {
    statusEl.innerHTML = callout("info", "Connect your wallet first.");
    app.connect?.();
    return false;
  }
  const label = button.innerHTML;
  button.disabled = true;
  button.innerHTML = `<span class="spin" aria-hidden="true"></span> Squeezing…`;
  try {
    const onStatus = (s) => (statusEl.innerHTML = stepsHtml(stepOf(s), s));
    const { hash, result } = typeof call === "function" ? await call(onStatus) : await app.chain.invoke(app.signer, ...call, onStatus);
    const url = app.chain.txUrl(hash);
    const text = describe(result);
    const link = url ? `<a href="${url}" target="_blank" rel="noopener">View on stellar.expert ${icon.external}</a>` : copyBtn(hash, `tx ${hash.slice(0, 10)}…`);
    const big = headline ? headline(result) : null;
    statusEl.innerHTML = successCard(kicker, big, text, link);
    toast(`<strong>${esc(kicker)}${/[.!?]$/.test(kicker) ? "" : "."}</strong> ${big ? big.replace(/<[^>]+>/g, "") : esc(text)}`, { ok: true });
    app.refresh(true).catch(() => {});
    return true;
  } catch (e) {
    statusEl.innerHTML = callout("bad", `<strong>Didn't go through.</strong> ${esc(e.message)}`);
    if (e.needsFunding && app.network === "testnet") {
      const b = document.createElement("button");
      b.className = "btn btn-ghost btn-sm";
      b.textContent = "Create Testnet account (free test XLM)";
      b.onclick = async () => {
        b.disabled = true;
        const r = await fetch(`https://friendbot.stellar.org/?addr=${app.signer.address}`);
        statusEl.innerHTML = callout(r.ok ? "good" : "bad", r.ok ? "Testnet account created. Try again." : `Friendbot failed (HTTP ${r.status}).`);
      };
      statusEl.querySelector(".callout > div").append(document.createElement("br"), b);
    }
    return false;
  } finally {
    button.innerHTML = label;
    button.disabled = false;
  }
}

/** Debounce for typing. */
export function debounce(fn, ms = 400) {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}
