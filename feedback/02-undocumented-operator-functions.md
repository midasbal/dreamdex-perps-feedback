# Undocumented owner-parameterised operator functions on the perp pool
Severity: normal
Area: docs
## Steps to reproduce
1. `npm install` (installs viem@2.57.7)
2. `node feedback-repro-02.mjs` (or `npm run repro:02`; deterministic re-run of the recorded output: `PIN_BLOCK=28571134 node feedback-repro-02.mjs`)
   Keyless: bytecode reads, storage reads, and `eth_call` simulations at one pinned block. No key, signer, or transaction. Section 2 also fetches two pinned public tarballs (npm + GitHub) and scans them in memory. Section 3 needs an RPC that supports `debug_traceCall` and `eth_call` state overrides (the Tokyo RPC does); on an RPC without them it skips that section and says so.
3. The script checks four function selectors against the ETH pool's implementation bytecode, scans the shipped SDK and bot-kit packages for them, and derives the operator grant each requires via a labelled registry state-override emulation.
## Expected
The operator-callable surface an integrator can discover from the SDK (@somnia-chain/markets-sdk@0.32.1) and the dreamDEX bot-kit should match the operator functions the pool actually implements and gates, so integrators know which owner-parameterised calls exist and what grant each needs.
## Actual
The ETH perp pool implements four owner-parameterised operator functions that are present in its implementation bytecode but absent from both shipped packages: `cancelOrdersFor`, `reduceOrdersFor`, `amendOrderFor`, `cancelAllOrdersFor`. (Section 1 of the script confirms all four selectors are present, with the three standard operator functions as present-controls and a made-up selector as an absent-control.)

**Package scan (section 2).** Across the SDK 0.32.1 package (632 files, including its `docs/` and README) and the bot-kit at commit 2579866 (592 files, including `docs/` and `skills/`), these four names have zero mentions of any kind. The SDK ships no ABI entry, and therefore no wrapper, for any of the seven `...For` functions. Only the bot-kit ships wrappers, and only for the three standard ones (`placeOrderFor`, `cancelOrderFor`, `reduceOrderFor`). Scope: this scan covers these two packages only; the hosted developer docs site was not scanned.

**Grant each requires (section 3, EMULATION).** This uses an `eth_call` registry storage override, clearly labelled in the script as an emulation and not a real partial grant. The script first proves that all 8 grant subsets resolve as intended, and that zero grants deny all 6 grantable functions. The derived requirements are: `cancelOrdersFor` needs the cancel grant, `reduceOrdersFor` needs reduce, `amendOrderFor` needs both place and cancel, and `cancelAllOrdersFor` is not operator-grantable (margin-bank only). All matched expectation in the recorded run. Function signatures for the four are reconstructed by analogy with the documented ones (see Evidence).

**Impact.** Not a security issue: as far as these simulations show, the functions are correctly access-controlled. The gap is discoverability. An integrator following the SDK/bot-kit surface cannot learn that these functions exist or which grant each needs (notably that `amendOrderFor` needs two grants). Suggested fix: document them with their grant requirements, or expose SDK wrappers.
## Evidence
- Repro script: `feedback-repro-02.mjs` at the repository root (keyless; viem is its only dependency; self-contained). Full deterministic run: `evidence/repro-02-run.txt` (pinned block 28571134).
- The four function signatures are reconstructed by analogy with the documented ones; the evidence they are correct is the selector match in the implementation bytecode plus calls that decode and dispatch.
## Environment
- Network: Somnia Tokyo testnet (Hideki), chain 50383
- Pool: ETH/USDso perp, `0xd6cb1dd58580b84d76068ac21594219ce03aeddf`
- Operator registry: `0x6B2FbfeD328FF5F20C0BE7D3C3437613aFFE8D3a`
- SDK scanned: @somnia-chain/markets-sdk@0.32.1; bot-kit at commit `25798660bbe4674a6f83a960b202852896e2fed4`
- Wallet (authorizing account): `0x9b29D1086BCa079CC07b859B406b84E5b8c9e7B1`
