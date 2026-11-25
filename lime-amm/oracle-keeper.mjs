// Local oracle keeper: keeps the mock SEP-40 oracle's EUR/USD price fresh on the LOCAL network.
// LimeFX refuses prices older than max_age (6 minutes on local), so without this every LimeFX
// quote and swap fails with StalePrice a few minutes after setup.
//
// Every INTERVAL seconds it reads the latest EUR price, moves it by a small random step
// (±2 bps, kept within ±1% of the starting price) and posts it with the current timestamp,
// signed by lime-owner (the oracle admin) through the stellar CLI.
//
// Usage: node oracle-keeper.mjs [--once] [--interval 60]     (local network only)
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const NET = process.env.NETWORK || "local";
if (NET !== "local") {
  console.error(`oracle-keeper only runs on the local network (got "${NET}"). On Testnet the oracle is Reflector.`);
  process.exit(1);
}
const args = process.argv.slice(2);
const ONCE = args.includes("--once");
const INTERVAL = Number(args[args.indexOf("--interval") + 1]) || 60;
const STEP_BPS = 2;
const EUR = '{"Other":"EUR"}';

const here = new URL(".", import.meta.url).pathname;
const deployed = JSON.parse(fs.readFileSync(`${here}deployed.local.json`, "utf8"));
const ORACLE = deployed.fx?.oracle;
if (!ORACLE) {
  console.error("deployed.local.json has no fx.oracle: run ./fx-pool.sh local first.");
  process.exit(1);
}

const cli = (...a) =>
  execFileSync("stellar", ["contract", "invoke", "--source-account", "lime-owner", "--network", NET, "--id", ORACLE, "--", ...a], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

const readLast = () => JSON.parse(cli("lastprice", "--asset", EUR));
let anchor = null; // starting price; the walk stays within ±1% of it

function tick() {
  const last = readLast();
  const price = BigInt(last.price);
  anchor ??= price;
  const stepBps = BigInt(Math.round((Math.random() * 2 - 1) * STEP_BPS)); // -2..+2
  let next = price + (price * stepBps) / 10_000n;
  const lo = (anchor * 99n) / 100n, hi = (anchor * 101n) / 100n;
  if (next < lo) next = lo;
  if (next > hi) next = hi;
  // Timestamps may not go backwards; equal timestamps overwrite the newest record.
  const ts = Math.max(Math.floor(Date.now() / 1000), Number(last.timestamp));
  cli("set_price", "--asset", EUR, "--price", next.toString(), "--timestamp", String(ts));
  const age = Math.floor(Date.now() / 1000) - Number(last.timestamp);
  console.log(
    `${new Date().toISOString()}  EUR/USD ${(Number(price) / 1e14).toFixed(5)} -> ${(Number(next) / 1e14).toFixed(5)}` +
      ` (${stepBps >= 0n ? "+" : ""}${stepBps} bps; previous price was ${age}s old)`,
  );
}

function safeTick() {
  try {
    tick();
  } catch (e) {
    console.error(`${new Date().toISOString()}  update failed: ${String(e.stderr || e.message).split("\n").filter(Boolean).slice(-2).join(" ")}`);
  }
}

console.log(`oracle-keeper: mock oracle ${ORACLE} on local, every ${INTERVAL}s (Ctrl+C to stop)`);
safeTick();
if (!ONCE) setInterval(safeTick, INTERVAL * 1000);
