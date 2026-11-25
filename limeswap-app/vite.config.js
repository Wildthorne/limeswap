import { defineConfig } from "vite";

// Dev-signer secrets (.env.local) must never end up in a production build:
// - VITE_DEV_SECRET (local network key) survives only when VITE_NETWORK=local;
// - VITE_DEV_SECRET_TESTNET (Testnet QA key) survives only on the dev server in QA mode
//   (`npm run dev:qa`), never in `vite build`. The app checks the network again before signing.
export default defineConfig(({ command }) => {
  const isLocal = process.env.VITE_NETWORK === "local";
  const qaServe = command === "serve" && process.env.VITE_QA === "1";
  return {
    // Reads ../deployed.<net>.json and ../lime-amm/deployed.<net>.json; one copy of the SDK.
    resolve: { dedupe: ["@stellar/stellar-sdk"] },
    server: { port: 5210, strictPort: true, fs: { allow: [".."] } },
    define: {
      global: "globalThis",
      ...(isLocal ? {} : { "import.meta.env.VITE_DEV_SECRET": "undefined" }),
      ...(qaServe ? {} : { "import.meta.env.VITE_DEV_SECRET_TESTNET": "undefined" }),
    },
  };
});
