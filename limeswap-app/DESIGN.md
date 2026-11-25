# LimeSwap design system

Round 1 built Nov 5, 2026; "Fresh Squeeze" identity Nov 6. Screenshots of every round: `screenshots/`
(`0-original`, `1-generic`, `2-fresh-squeeze`; index in `screenshots/README.md`).

Design references were collected on Mobbin (links to the individual screens below).

## Identity: "Fresh Squeeze" (chosen by Dimitar, Nov 6, 2026)

Round 1 (Nov 5) gave LimeSwap a clean, Uniswap-like layout. Dimitar's verdict: "too generic". Round 2
kept that layout and added an identity. Two directions were mocked (`design-mocks/a-fresh-squeeze`,
`design-mocks/b-trading-ticket`, HTML + PNG): A "Fresh Squeeze" (juicy, warm) and B "Trading Ticket"
(printed receipts, mono). Dimitar picked **A**.

**Motif: the lime slice.** One pure-CSS component (`.lime-slice`: pith centre, segments, pith ring,
rind) is the logo, the favicon, the loading spinner (it spins), your account avatar (each address gets
its own citrus colour: lime, orange, grapefruit…), the "no wallet yet" note badge and the centre of the
success burst (slice + tick + flying wedges and juice drops). The Get test tokens panel has a glass that
fills a third per finished step.

**Voice.** Warm and short first, then the plain facts, never instead of them: "Plug in your wallet",
"Say yes to your tokens", "Grab your daily squeeze", "Freshly squeezed! +11.2131 LUSD", "Poured in",
"Back in your wallet", "No juice here: nothing matches …". Every original explanation stays.

**Micro-interactions.** Lime buttons sit on a darker "rind" and press down 3 px; the flip button spins
with a bounce; sheets rise with a little overshoot; success pops the slice and throws wedges; toasts slide
in on pith paper (dark mode) or rind (light mode). `prefers-reduced-motion` switches all of it off.

## Palette

| Token | Dark ("rind") | Light ("pulp") | Use |
|---|---|---|---|
| `--bg` | `#0A1D12` | `#F7F4E6` | page |
| `--surface` / `-2` / `-3` | `#10281A` / `#163522` / `#1D4029` | `#FFFDF4` / `#F0ECD9` / `#E6E1C8` | cards, panels, chips |
| `--line` | `#24503A` | `#E0DBC2` | borders |
| `--text` / `--muted` | `#F3F8E6` / `#A8C1A6` | `#13241A` / `#56685A` | body / captions (≥ 4.5:1) |
| `--lime` + `--on-lime` | `#C6F432` + `#0A1D12` | same | primary fill, active tab, flip |
| `--lime-deep` | `#6F9A10` | `#8BBD1C` | the "rind" under pressable buttons |
| `--lime-ink` | `#C6F432` | `#4A7A08` | lime drawn as text/links |
| `--zest` | `#FFE14D` | `#8A6A00` | juice drops, Get test tokens chip, hint notes |
| `--pith` | `#F3F0D8` | `#FFFDF4` | slice pith, wallet tile, dark-mode toasts |
| good / warn / bad / info | `#7BE38F` `#FFD25E` `#FF8A7A` `#8FD3FF` | `#1E7A3A` `#9A5200` `#C0392B` `#0B6AA2` | callout badges, impact |

## Type

- **Bricolage Grotesque** (variable, OFL, self-hosted via `@fontsource-variable/bricolage-grotesque`
  5.3.0, so there's no request to Google): titles, big amounts, tab labels, buttons, kickers. Quirky and warm.
- System UI for body text and captions; monospace only for IDs.

## Spacing and shape

4 px grid (4, 8, 12, 16, 20, 24, 32, 48). Radius 12 (inputs, chips), 16 (inner panels),
24 (main cards), pills fully round. One soft shadow on floating things only (sheets, toasts).
Every tab uses one 520 px column (Swap, Pools, Liquidity), on desktop and phone alike.

## Components

- **Top bar:** lime logo mark, centred segmented nav (Pools · Swap · Liquidity), network chip with
  a status dot, yellow **DEV SIGNER** chip on local, wallet button → address chip after connect.
  Up to 900 px wide the nav becomes a floating bottom tab bar (thumb reach, like Revolut/Phantom);
  below 480 px the logo drops its word mark so the chips fit.
- **Token panel:** label, big amount input, token button (avatar + symbol + chevron), balance +
  Max underneath. The receive panel shows the best quote as the big number.
- **Token picker:** modal on desktop, bottom sheet on phone; search, each row = avatar, symbol,
  plain note ("regulated fund token: issuer must authorize holders"), your balance.
- **Quote summary:** one line "1 LEUR = 1.1221 LUSD · fee 0.11%"; expands into receipt rows
  (route, rate, oracle/pool price, fee, price impact, minimum received, max slippage), each with
  a "?" tooltip carrying today's explanation.
- **Route view:** the best route drawn as a path (token → venue → token), plus "Compare N routes"
  listing every LimeSwap tier, 2-hop and mixed LimeSwap → LimeFX route with its output and a
  Best tag; failed routes stay, greyed, with the reason.
- **Settings popover (gear):** slippage chips 0.1 / 0.5 / 1 % + custom.
- **Action button:** always says what's next or what's wrong ("Enter an amount", "Insufficient
  LEUR", "Add an LUSD trustline first", "Swap"), the Uniswap pattern.
- **Transaction status:** progress steps under the button (simulate → sign → send → confirm),
  then a success toast/sheet with the result and a "View on stellar.expert" link; errors stay
  inline in red with the plain-language reason.
  The result box clears as soon as you edit the swap form; until then it turns into "Last swap · confirmed"
  with a one-line note when the fresh quote above shows another route or an output more than 0.1% away
  (added Nov 6 after Dimitar's Testnet test: the new best route under an old "Confirmed" looked contradictory).
- **Get test tokens panel:** a three-step checklist card above the tabs (number bubble → green check,
  the current step outlined in lime, later steps dimmed and disabled), one action button per step, the
  shared progress steps under it, and "Start swapping" when all three are done. A lime "Get test tokens"
  chip in the header reopens it (icon only below 1,100 px).
- **Callouts:** coloured notes (info / good / warn / bad) for trustline, compliance, breaker and owed
  amounts, each with a round badge (i / ✓ / !); `zest` = a dashed lemon note with a mini slice (wallet hint).
- **Pools:** LimeFX as a featured card (price from the oracle, freshness meter for oracle age that turns
  amber at half the limit and red at 85%, dynamic fee with its range, amp, safety band, breaker); LimeSwap
  pools as stacked cards (label above value) at every width, a "You · x%" badge on pools you're in.
- **Liquidity:** pool chooser at the top, a position card (your shares, % of pool, worth now,
  wallet), a Deposit / Withdraw segmented switch; withdraw gets 25 / 50 / 75 / Max chips plus the
  slider; owed + Claim and compliance notes as callouts.
- **Loading:** shimmer skeletons in the exact shape of the content (pool rows, the quote number,
  the position card) while Testnet reads take 1–4 s; "Updated 23:30 · live" chip with a pulsing dot.
- **Accessibility:** visible 2 px lime focus ring, 44 px touch targets, `aria-live` on quotes and
  transaction status, reduced-motion respected, no horizontal scroll at 375 px.

## References and why

| Reference | Pattern taken |
|---|---|
| [Uniswap swap (filled)](https://mobbin.com/screens/0445fa8a-4dd3-48dc-bbbd-ac37556499e6) | Stacked Sell/Buy panels, flip button, collapsed rate line under the button |
| [Uniswap review modal](https://mobbin.com/screens/a619a575-5745-4ad8-978c-b25aaaa9bfc5) | Receipt rows: fee, rate, max slippage, routing, price impact, each with "?" |
| [Base trade modal](https://mobbin.com/screens/09a5bbe0-2943-4077-9f53-eddf516df513) | Very large amount numerals, compact token chip, "Use max" next to balance |
| [OpenSea swap panel (dark)](https://mobbin.com/screens/52822748-0cbc-4991-a805-4c6b9295bc3c) | Lime-on-near-black palette proof: how a lime CTA reads in dark mode |
| [Uniswap top pools](https://mobbin.com/screens/2182b468-736e-46f0-8b57-b111d16bd4f8) | Pools table: pair avatars, version/fee chip, right-aligned numbers |
| [Uniswap positions + pools](https://mobbin.com/screens/d70a77b4-d424-4267-ba9a-23645a9c63b0) | "Your positions" above the pool list, side "learn" card for explanations |
| [Uniswap new position: deposit](https://mobbin.com/screens/0b5cd7da-6f44-4c49-be7d-be556cccd0ec) | Two deposit panels, insufficient-balance shown in red on the amount + button label |
| [Kraken earn modal](https://mobbin.com/screens/b4d5531e-5721-4ebb-981f-9ed37e12f01f) | 25 / 50 / 75 / Max chips for withdraw |
| [Kraken order receipt](https://mobbin.com/screens/e058dd49-b3cf-4d60-86ac-cc5aa77bd932) | Result receipt with copyable transaction ID |
| [Airwallex review conversion](https://mobbin.com/screens/7acc57b5-66ca-49fc-9c0c-8a850a90f029) | Vertical from → rate → to timeline; "refreshed at" time on the rate (our oracle age) |
| [Uniswap iOS token sheet](https://mobbin.com/screens/4e1c3615-ffe9-4dab-adac-25564a9b93fb) | Bottom-sheet token picker with search and "your tokens" balances |
| [OKX token picker (web)](https://mobbin.com/screens/892db49e-5a53-4f87-8b14-dda523195762) | Desktop modal picker; filter chips (All / Stablecoins) |
| [Phantom select asset](https://mobbin.com/screens/ec80d82c-0238-48ad-99ec-9c7ae967b20e) | Dark grouped list rows with secondary line under the symbol |
| [Solflare success sheet](https://mobbin.com/screens/250d97bb-2461-49d4-9e41-8b15a872ba50) | Success state with transaction ID + explorer link |
| [Revolut exchange toast](https://mobbin.com/screens/6d39f68d-af45-4e5b-9494-42931b87778c) | Light confirmation ("You sold $2 for US$1.49") instead of a blocking page |
| [Coinbase connect wallet](https://mobbin.com/screens/0028e86d-943f-4bfd-8be6-ce4f873921ce) | Simple wallet list with one-line explanation per wallet: Varial (formerly Freighter) and MetaMask through the Stellar Snap, each a chunky row with its own tile (MetaMask in its orange) |

## What stays exactly the same
All chain logic (`src/chain.js`, `dex.js`, `wallet.js`, `errors.js`), every number currently shown,
every warning and explanation (moved into captions/tooltips/callouts, not removed), the dev signer
rules, and the 10 s refresh.

## How it's built

| File | What's in it |
|---|---|
| `style.css` | Tokens (`:root`, light via `prefers-color-scheme` or `data-theme`), then base, top bar, cards/panels, buttons, chips, receipts, callouts, tx steps, toasts, dialog, skeletons, per-tab blocks, phone rules |
| `src/ui/dom.js` | `setHtml` (re-render only on change, so focus/open state survive the 10 s refresh), `tokenAvatar`/`pairAvatar`, `tip`, `callout`, `copyBtn`, `toast`, `openPicker` (native `<dialog>`: modal / bottom sheet), `runTx` (progress steps → result + toast) |
| `src/ui/swap.js` | Token panels + picker, slippage popover, quote receipt, route path + comparison, the "smart" action button |
| `src/ui/pools.js` | LimeFX featured card (freshness and fee meters), expandable pool rows with Trade / Add liquidity shortcuts |
| `src/ui/liquidity.js` | Pool chooser, position card, Deposit / Withdraw switch, 25/50/75/Max chips, owed + Claim, compliance callouts |

Rules of thumb when changing the UI:
- Colours only through tokens; a new colour needs a dark **and** a light value.
- Numbers get `tabular-nums` (already on `.amount`, `dd`, `.value`).
- Every explanation the old UI had is still there: as a caption, a `tip()` or a `callout()`. Don't delete
  one without moving it.
- A new token gets an avatar entry in `AVATARS` (`src/ui/dom.js`): glyph + colour (+ `true` for dark text on a light colour).
- Grid/flex children that hold long numbers need `min-width: 0`, or a phone gets horizontal scroll.
- Don't put `backdrop-filter`/`transform`/`filter` on an ancestor of the phone tab bar: it turns into the
  containing block and the "fixed" bar scrolls away (bit us once).

## Decluttering rules (Nov 6, after an independent design audit)
- One problem, one message: when the action button already names the blocker ("Insufficient LEUR",
  "No route from LEUR to LFUND"), no callout repeats it; a fix link goes next to the cause (e.g. "Get test
  tokens" beside the balance). Risk warnings (high price impact, trustline, compliance) stay, but high
  impact only shows when nothing else blocks the swap.
- No labels that say nothing to a trader (taglines, "Updated …", counts, "N checked"); the data-age line
  appears only when data is stale. Detail lives in "?" tooltips.
- Swap details show only what isn't on the card already: oracle/pool price, fee, price impact, minimum
  received (with the slippage in brackets). The slippage chip next to the gear appears only when changed.
- Solid lime marks the main action, the active tab and "yours" (You badge, selected position); the flip
  button and venue pills are neutral.
- Error codes (e.g. #14) live in tooltips, not in sentences.
- Structure (after the audit's restructures): no visible page titles (screen-reader headings only; the
  active tab says where you are). Swap: the route and the route comparison live inside the swap details;
  they show on their own only when every route failed. Pools: LimeFX shows price, oracle age, fee and
  reserves, with amp / safety band / circuit breaker behind "Pool details"; pool rows are one line
  (pair, tags, price) with reserves, 10-min average and reverse rate when opened, fee tiers of a pair next
  to each other. Liquidity: Your positions (with a wallet) → one card with the pool picker and
  Deposit/Withdraw (also without a wallet: amounts pair up, the button connects) → pool reserves and
  notes. Each position row shows only its value and a profit/loss chip ("▼ $0.14 · 0.1%" = worth now
  minus what you put in, at the prices of that day); the chevron opens You put in / Worth now /
  Profit / loss / Fees earned plus one plain sentence comparing with keeping the tokens in your wallet
  (impermanent loss sits behind its "?"), instead of the old "vs holding" figure.
  Demo KYC (LFUND): while approval is what's missing, Liquidity's main button itself reads "Verify me
  (demo KYC)" and runs the check (the info callout only explains, no second button); the Pools row's
  compliance tag reads "LFUND · verify to trade" for visitors without a wallet and unverified accounts. Get test tokens: done steps show only their tick; once everything is done the panel collapses
  to "All set · next daily claim in …" and the header chip hides.

## Verified (Nov 6, 2026, Fresh Squeeze)
- Brand-new Testnet account through the QA dev signer (`limeswap-app-qa-fresh`): Friendbot → 3 trustlines
  → faucet claim → swap 10 LEUR → 11.214 LUSD ("Freshly squeezed") → LimeFX deposit ("Poured in"). Swap
  balances update about 5 s after the claim. Screenshots: `screenshots/2-fresh-squeeze/`.
- `NETWORK=testnet npm run smoke` passes; `npm run e2e` 7/7 on Testnet; no unnamed controls in the ARIA tree;
  no horizontal scroll at 375 px; dark and light checked.

- Laptop QA (1280–1920 px, dark and light, with and without a wallet): no horizontal scroll, overlaps or
  clipped text; tabs centred. Positions P&L checked expanded and collapsed at 1280/1440/1536 and 375 px,
  keyboard toggle works. Screenshots: `screenshots/2-fresh-squeeze/laptop-qa/`, `positions-pnl/`.

## Verified (Nov 5, 2026)
- Local, dev signer: LEUR → XLM through the mixed route LimeFX → LimeSwap 0.3% (received 43.3285 XLM),
  deposit 2 LEUR + 2.2421 LUSD into LimeFX (2.1176 LP shares), Withdraw preview; `npm run smoke` passes.
- Testnet (read-only, no wallet): pools, LimeFX card, live quotes, "Connect wallet" states, loading skeletons.
- No horizontal scroll at 375 px on any tab (checked `scrollWidth` in Playwright with phone emulation), dark and light.
- Not yet done: a Freighter/Varial signing pass on Testnet with the new UI (Dimitar's wallet).
