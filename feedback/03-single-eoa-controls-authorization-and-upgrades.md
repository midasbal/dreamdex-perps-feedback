# A single EOA owns and can upgrade the entire authorization and collateral path
Severity: major
Area: contracts
## Steps to reproduce
1. `npm install` (installs viem@2.57.7)
2. `node feedback-repro-03.mjs` (or `npm run repro:03`; deterministic re-run of the recorded output: `PIN_BLOCK=28575703 node feedback-repro-03.mjs`)
   Keyless: view, storage and bytecode reads, plus labelled `eth_call` upgrade simulations, all at one pinned block. No key, signer, or transaction.
3. The script reads `owner()` / `pendingOwner()` of the OperatorPermissionsRegistry, the MarginBank, the ETH PerpPool, its beacon, and the PerpPoolFactory (plus the liquidation engine and insurance fund named in the bank's `getSystemConfig`), classifies each owner as EOA vs contract/multisig, and simulates an upgrade-to-current-implementation from the owner and from a neutral address.
## Expected
Control over the contracts that decide who may trade for an account (OperatorPermissionsRegistry), hold all user collateral (MarginBank), and implement and upgrade the markets (PerpPool, its beacon, and the factory) should be distributed, for example behind a multisig and/or timelock, so that no single key compromise can seize funds or re-authorize operators. (Framed for mainnet readiness; see Impact.)
## Actual
At block 28575703, one externally-owned account, `0xd58596620Ee6951B2958a931949e4ff7ce6222be`, is `owner()` of all of: the OperatorPermissionsRegistry, the MarginBank, the ETH PerpPool, the PerpPool beacon, and the PerpPoolFactory. It is also `owner()` of the liquidation engine and the insurance fund (both read from the bank's `getSystemConfig`). The address has no contract code at that block, so it is a plain EOA and cannot be a Safe or any other multisig or timelock contract. It has sent 2,233 transactions, and it is also the MarginBank's `feeRecipient`.

Upgrade authority is demonstrated by simulation, not assumed (section 4 of the script). Simulating `upgradeToAndCall` (registry, bank, factory) and `upgradeTo` (beacon) to each contract's own current implementation, which would be a no-op and sends nothing, succeeds from this owner on all four and reverts with `OwnableUnauthorizedAccount` from a neutral address. The ETH pool itself is upgraded through its beacon.

Ownership transfer is two-step (`pendingOwner` + `acceptOwnership` present) on the registry, bank, pool, and factory, and `pendingOwner()` is zero on each, so no handover is pending. The beacon is single-step.

**Impact.** On testnet a single-EOA admin is normal and expected, and this is not a live vulnerability here; this is a mainnet-readiness finding. If this key, or this ownership layout, were carried to a mainnet deployment unchanged, a single key compromise or mistake could upgrade the registry (changing which operators may act for any account), the collateral-holding MarginBank, the factory, and every beacon-proxied pool. By inference from that upgrade authority, this could be used to seize user collateral or re-authorize trading; the script does not simulate anything beyond the no-op upgrade. Suggested hardening before mainnet: make a multisig, optionally behind a timelock, the owner of all of these, and publish who holds upgrade authority in the developer docs.
## Evidence
- Repro script: `feedback-repro-03.mjs` at the repository root (keyless; viem is its only dependency; self-contained). Full deterministic run: `evidence/repro-03-run.txt` (pinned block 28575703).
- Limits: reads are as of the pinned block; only the ETH pool was checked (its beacon is shared by other pools, which were not enumerated).
## Environment
- Network: Somnia Tokyo testnet (Hideki), chain 50383
- Owner EOA: `0xd58596620Ee6951B2958a931949e4ff7ce6222be`
- Registry `0x6B2FbfeD328FF5F20C0BE7D3C3437613aFFE8D3a`; MarginBank `0x478769E1177C0773c43A593DCCc4Ad15F15F1394`; ETH PerpPool `0xd6cb1dd58580b84d76068ac21594219ce03aeddf`; PerpPool beacon `0xb787F7d2F87d32c1505C110c4457eD36A3f6b002`; Factory `0xE631fAEE547baeE07353E290f0562ea67d856560`
- Liquidation engine `0xA66d3C24Ad4a389d863846905D8173e1017e9F4D`; insurance fund `0x50826894D47C6D4f3BeA38BFDC7Dc5c5be171b80` (both from the bank's `getSystemConfig`)
- SDK: @somnia-chain/markets-sdk@0.32.1 (the repro itself uses only viem@2.57.7)
