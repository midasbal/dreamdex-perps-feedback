# Position lastUpdatedTimestampNs is documented as a timestamp but is always zero
Severity: normal
Area: docs
## Steps to reproduce
1. `npm install` (installs viem@2.57.7)
2. `node feedback-repro-04.mjs` (or `npm run repro:04`). It runs at the recorded block 28619406 by default, so the output is reproducible; `PIN_BLOCK=latest node feedback-repro-04.mjs` uses the current head instead.
   Keyless: view reads, log reads, storage-trace reads, one indexer query and one public tarball download that is scanned in memory. No key, signer, or transaction. The oldest-positions sample needs the indexer; the storage view needs an RPC that supports `debug_traceCall` (the Tokyo RPC does) and is skipped with a note otherwise.
3. The script reads our Safe's position, samples live positions in the same pool (the 10 most recently updated from on-chain `PositionUpdated` logs and the 10 oldest from the indexer, each confirmed live on chain), reads their `lastUpdatedTimestampNs`, shows the raw return words and the struct's storage slots, and searches the shipped SDK for any other position timestamp.
## Expected
`MarginBank.getPosition()` returns a struct whose last field is documented in the SDK as "Last position update (nanoseconds)" (`package/src/perp/state.ts` lines 469-470 in @somnia-chain/markets-sdk@0.32.1). A consumer should be able to rely on it holding the nanosecond timestamp of the position's last update, or the field should not be presented as one.
## Actual
`lastUpdatedTimestampNs` is `0` on every live position tested, however recently or long ago the position was updated. At block 28619406:
- **Our position.** The Safe's long (opened in tx `0x0d6392c3636aede9f7e36ea64bb42986f53bb8c6968d015b952f24dceea4b47c` at block 28608011) reads `lastUpdatedTimestampNs = 0`. The pool's last funding settlement (16:19:18 UTC) was after the open (16:11:38 UTC), and the field is still 0.
- **Not a decoding artifact.** The raw `getPosition` return is exactly 4 words (128 bytes). Words 0 to 2 decode to `size`, `avgEntryPrice` and `entryFundingIndex`; word 3, the timestamp, is all zeros. The struct shape matches the ABI.
- **Storage.** A `prestateTracer` trace shows the position struct occupies 3 storage slots (`size` and `avgEntryPrice` packed, `entryFundingIndex`, and the timestamp). The timestamp slot reads `0x00...00` for our Safe, for the oldest sampled position, and for a position updated 5 seconds before the pinned block.
- **Across accounts.** 21 live positions were examined (ours plus 20 others): the 10 most recently updated (5 seconds to 7 minutes 38 seconds since their last `PositionUpdated`) and the 10 oldest (14 days 7 hours to 21 days 6 hours since their last indexer update, the oldest at `updatedAtBlock` 10,284,139 against a pinned block of 28,619,406). All 21 read `0`.
- **No other source.** `getPosition` is the only position getter in the shipped ABIs, and `lastUpdatedTimestampNs` is its only timestamp field. The `PositionUpdated`, `PositionTransferred`, `PositionLiquidated`, `PositionSkippedBelowMinQuantity` and `PositionTakenOver` events carry no timestamp. The indexer's `updatedAt` and `updatedAtBlock` are populated while the on-chain field is 0, so they cannot be derived from it.

The most likely cause is that no code path in the contract writes this struct slot while the SDK type and comment present it as meaningful. This is inferred from the observed zeros and the zero storage slot, not from the contract source.

**Impact.** Low. This is a silent wrong value rather than a revert, which is why it is worth reporting: a consumer that uses the field for a staleness check or a time-since-update calculation gets `0` with no error. No funds, authorization or state are at risk, and this is not exploitable. Suggested fix, any one of: (a) populate the field on every position write (open, modify, settle) with `block.timestamp * 1e9`; (b) remove it from the struct and the SDK type; (c) document it as reserved or unused so consumers do not rely on it.
## Evidence
- Repro script: `feedback-repro-04.mjs` at the repository root (keyless; viem is its only dependency; self-contained). Full deterministic run: `evidence/repro-04-run.txt` (pinned block 28619406; a re-run with `PIN_BLOCK=28619406` is identical apart from the block-line tag).
- SDK documentation quoted from the published tarball: `package/src/perp/state.ts:469` "Last position update (nanoseconds)", `:470` `lastUpdatedTimestampNs: bigint`; ABI `package/dist/readsAbi.js`, `getPosition(address,address)`.
- Limits: one pool (ETH-PERP), one block, one chain (Hideki). "Age" for the oldest group is the indexer's last-update time, not necessarily the position's creation or the version of the contract that wrote it. Other pools were not checked.
## Environment
- Network: Somnia Tokyo testnet (Hideki), chain 50383
- MarginBank: `0x478769E1177C0773c43A593DCCc4Ad15F15F1394`
- Pool: ETH/USDso perp, `0xd6cb1dd58580b84d76068ac21594219ce03aeddf`
- SDK: @somnia-chain/markets-sdk@0.32.1 (the repro itself uses only viem@2.57.7)
- Account whose position was read first: the Safe `0x9b29D1086BCa079CC07b859B406b84E5b8c9e7B1`
