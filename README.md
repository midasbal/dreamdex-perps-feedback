# dreamDEX Perps Builder Bounty - Feedback (Somnia Tokyo testnet)

Keyless, reproducible feedback-track findings for dreamDEX perps on the Hideki (Tokyo) testnet, chain 50383.

## Findings

| Report | Severity | Area | Summary |
|---|---|---|---|
| [01](feedback/01-stale-order-id-misleading-owner.md) | normal | contracts | Stale order id: `cancelOrder` / `reduceOrder` / `reduceOrders` revert with `IncorrectSender` naming an unrelated address |
| [02](feedback/02-undocumented-operator-functions.md) | normal | docs | Undocumented owner-parameterised operator functions on the perp pool (absent from the SDK, the bot-kit and their docs) |
| [03](feedback/03-single-eoa-controls-authorization-and-upgrades.md) | major | contracts | A single EOA controls authorization and upgrades (a mainnet-readiness note; normal on testnet) |
| [04](feedback/04-lastupdated-timestamp-dead-field.md) | normal | docs | `getPosition().lastUpdatedTimestampNs` is documented as a timestamp but is always 0 (low impact; a silent wrong value, not exploitable) |

## Repo layout

- `feedback/` - one markdown report per issue, in the `feedback/TEMPLATE.md` format.
- `feedback-repro-01.mjs` to `feedback-repro-04.mjs` - the standalone reproduction for each report.
- `feedback/evidence/` - captured output of each repro, recorded at a pinned block (`repro-0X-run.txt`).
- `package.json` - pins viem, the only dependency.

## Requirements

- Node 18 or newer.
- Network access to the Tokyo RPC (`https://api.hideki2.infra.testnet.somnia.network`).
- For repro-02 only: access to npm and GitHub, to fetch two public tarballs that are scanned in memory. Its section 3 also needs an RPC that supports `debug_traceCall` and `eth_call` state overrides (the Tokyo RPC does); on an RPC without them that section is skipped and says so.
- For repro-04 only: access to the indexer (`https://hideki-dev.smk.somnia.host/v1/graphql`, for the oldest-positions sample) and to npm (one public tarball scanned in memory). Its storage view needs `debug_traceCall` and is skipped with a note otherwise.

## How to run

```
npm install
node feedback-repro-01.mjs      # or: npm run repro:01
node feedback-repro-02.mjs      # or: npm run repro:02
node feedback-repro-03.mjs      # or: npm run repro:03
node feedback-repro-04.mjs      # or: npm run repro:04
```

The repros are keyless and read-only: they use reads and `eth_call` simulations only. No private key, signer or transaction is involved.

A plain run of repro-01 to repro-03 uses the latest block, so some values change over time (for example the addresses named in report 01). Repro-04 instead runs at its recorded block by default (`PIN_BLOCK=latest` uses the head). To reproduce the exact recorded runs, pin the block:

```
PIN_BLOCK=28564579 node feedback-repro-01.mjs
PIN_BLOCK=28571134 node feedback-repro-02.mjs
PIN_BLOCK=28575703 node feedback-repro-03.mjs
PIN_BLOCK=28619406 node feedback-repro-04.mjs
```

A pinned run needs an RPC that still serves state at that block (the Tokyo RPC did when these were recorded). Apart from a "(set via PIN_BLOCK)" tag on the block line, it matches the file in `feedback/evidence/`.

## Proof of building

A working place and cancel cycle on Tokyo, placed as the operator for the Safe:

| Step | Tx hash | Outcome |
|---|---|---|
| Place (POST_ONLY bid, ETH/USDso perp) | `0x737a3b06b869e1c2ca682b91696995e2ed80be019c72fbf401900fdef5a3ba05` | succeeded, order rested open with no fills |
| Cancel | `0xe6aed37efb676d715922872bf599f557ce9e92582094ae3979acc98ffdb9b448` | succeeded, order removed, margin released |

Explorer: https://explorer.testnet.somnia.network/tokyo

The bot EOA was authorized through the app's Link-a-Bot flow and placed the orders as the operator for the Safe, which holds the margin; the bot pays its own gas and holds no funds. The `placeOrderFor` and `cancelOrderFor` calls were sent with viem, following the dreamDEX bot-kit's operator pattern, because `@somnia-chain/markets-sdk@0.32.1` ships no `...For` write for perps; the SDK was used for reads, sizing and decoding. The sending scripts live in a private working folder and are not included here. The feedback repros in this repository are read-only and need no key.

## Addresses used (public)

- Safe (smart-account owner of the margin): `0x9b29D1086BCa079CC07b859B406b84E5b8c9e7B1`
- Operator bot EOA: `0x47a34Ad5b25dF3887Bde8FC7C20c4711495D568D`

The protocol owner EOA and the contract addresses appear in the individual reports.
