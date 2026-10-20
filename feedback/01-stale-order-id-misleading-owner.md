# Stale order id makes cancel/reduce revert with IncorrectSender naming an unrelated address
Severity: normal
Area: contracts
## Steps to reproduce
1. `npm install` (installs viem@2.57.7)
2. `node feedback-repro-01.mjs` (or `npm run repro:01`; deterministic re-run of the recorded output: `PIN_BLOCK=28564579 node feedback-repro-01.mjs`)
   Keyless: `eth_call` simulations and reads at one pinned block. No key, signer, or transaction. The named addresses change over time (see Actual), so a plain run can differ from the recorded output; the pinned run needs an RPC that serves state at that block (the Tokyo RPC did).
3. The script takes three order ids that are no longer active (confirmed via `pool.getOrder` reverting `IncorrectOrder`), including order A (10348623425351065400181), which this account placed and cancelled (place tx `0x737a3b06…ba05`, cancel tx `0xe6aed37e…b448`), and calls `cancelOrder`, `reduceOrder`, `reduceOrders`, `cancelOrderFor` and `amendOrder` on each.
## Expected
Calling `cancelOrder` / `reduceOrder` / `reduceOrders` with an order id that does not exist should revert with an order-not-found style error. The pool already has such errors: `amendOrder` reverts `AmendOldOrderGone`, and the pool's own `getOrder` view reverts `IncorrectOrder`, for the same ids.
## Actual
`cancelOrder`, `reduceOrder` and `reduceOrders` revert with `IncorrectSender(sender, expected)`, where `expected` is an unrelated third-party address that does not own an active order with that id. At block 28564579: ids A and B named `0x6C2986A550DC4212b49a1710d8466553E3761ce4`; id C named `0xD3Ecd94b11Dfe7515d5614b0458Bf22175aDE619`. For order A the true historical owner is the Safe `0x9b29D1086BCa079CC07b859B406b84E5b8c9e7B1` (shown by decoding the place tx's `placeOrderFor` owner argument), yet the error names a different address. The same misleading `IncorrectSender` is returned through `cancelOrderFor` when called by an authorized operator (an unauthorized caller gets `OnlyApprovedContracts` first). `amendOrder`, by contrast, correctly reverts `AmendOldOrderGone` for the same ids.

The named address changes over time and per id. The behavior is consistent with the owner check running against whichever order currently occupies the id's storage slot (ids appear to be structured as `(slotIndex << 64) | sequence`) before the id itself is validated; a later check (`IncorrectOrder`) still prevents any state change. This mechanism is inferred from behavior, not from source.

**Impact.** This is an error-semantics / information-quality issue, not an exploit. No state changes (every call reverts; `debug_traceCall` of `cancelOrder` on order A shows zero events emitted), and the operation is correctly blocked. But a bot whose order has filled or been cancelled receives an authorization-style error (`IncorrectSender`) naming an unrelated party, rather than a clear "order not found", which is misleading for integrators and puts an unrelated address into the error. Suggested fix: validate the order id first and revert with a dedicated order-not-found error (as `amendOrder` and `getOrder` already do).
## Evidence
- Repro script: `feedback-repro-01.mjs` at the repository root (keyless; viem is its only dependency; self-contained).
- Full run output, captured at pinned block 28564579: `evidence/repro-01-run.txt`
- Place tx (shows A was the Safe's): `0x737a3b06b869e1c2ca682b91696995e2ed80be019c72fbf401900fdef5a3ba05`
- Cancel tx: `0xe6aed37efb676d715922872bf599f557ce9e92582094ae3979acc98ffdb9b448`
## Environment
- Network: Somnia Tokyo testnet (Hideki), chain 50383
- Pool: ETH/USDso perp, `0xd6cb1dd58580b84d76068ac21594219ce03aeddf`
- SDK: @somnia-chain/markets-sdk@0.32.1 (the repro itself uses only viem@2.57.7)
- Wallet (account that placed/cancelled order A): `0x9b29D1086BCa079CC07b859B406b84E5b8c9e7B1`
