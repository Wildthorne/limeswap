// Amount helpers. Every token here has 7 decimals (Stellar's standard), but we read decimals()
// from chain and pass it in, so nothing silently breaks for a token that differs.

export const PRICE_SCALE = 10n ** 14n; // TWAP prices, LimeFX oracle price, SEP-40 price

/** "12.5" -> 125000000n (for 7 decimals). Returns null for anything that isn't a positive number. */
export function parseAmount(text, decimals = 7) {
  const s = String(text ?? "").trim().replace(/,/g, "");
  if (!/^\d*\.?\d*$/.test(s) || s === "" || s === ".") return null;
  const [whole, frac = ""] = s.split(".");
  if (frac.length > decimals) return null;
  const v = BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
  return v > 0n ? v : null;
}

/** 125000000n -> "12.5" (trimmed), with at most `maxFrac` fraction digits. */
export function fmtAmount(v, decimals = 7, maxFrac = 4) {
  if (v === null || v === undefined) return "–";
  v = BigInt(v);
  const neg = v < 0n;
  if (neg) v = -v;
  const unit = 10n ** BigInt(decimals);
  const whole = v / unit;
  let frac = (v % unit).toString().padStart(decimals, "0").slice(0, maxFrac).replace(/0+$/, "");
  // Tiny but non-zero: show more digits rather than a misleading 0.
  if (whole === 0n && frac === "" && v > 0n) frac = (v % unit).toString().padStart(decimals, "0").replace(/0+$/, "");
  return (neg ? "-" : "") + whole.toLocaleString("en-US") + (frac ? "." + frac : "");
}

/** Exact amount for an input field (no thousands separators, all decimals kept). */
export function toInput(v, decimals = 7) {
  const unit = 10n ** BigInt(decimals);
  const frac = (BigInt(v) % unit).toString().padStart(decimals, "0").replace(/0+$/, "");
  return (BigInt(v) / unit).toString() + (frac ? "." + frac : "");
}

/** Ratio of two bigints as a JS number (fine for display). */
export const ratio = (a, b) => (Number(b) === 0 ? NaN : Number(a) / Number(b));

/** Price number for display: 4 significant-ish digits, never scientific notation. */
export function fmtPrice(x) {
  if (!Number.isFinite(x)) return "–";
  if (x >= 1000) return x.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (x >= 1) return x.toFixed(4);
  return x.toPrecision(4);
}

export const fmtBps = (bps) => `${(Number(bps) / 100).toFixed(2)}%`;
export const fmtPct = (x, digits = 2) => (Number.isFinite(x) ? `${(x * 100).toFixed(digits)}%` : "–");

export function fmtAge(seconds) {
  if (seconds < 0) return "in the future";
  if (seconds < 90) return `${seconds}s ago`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min ago`;
  return `${(seconds / 3600).toFixed(1)} h ago`;
}

export const short = (a) => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : "");
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
