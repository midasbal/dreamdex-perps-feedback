// feedback-repro-03.mjs
//
// OBSERVATION (testnet / mainnet-readiness note, NOT a live exploit): who controls the authorization and upgrade path of the perp system?
//
// Reads, at one pinned block, the owner (and admin / upgrade authority) of the contracts that decide who may trade for an account
// (OperatorPermissionsRegistry), hold user collateral (MarginBank), and implement the markets (PerpPool + its beacon + the factory),
// and classifies each owner as EOA vs contract / multisig. On a testnet a single-EOA admin is normal and expected; the point is only that
// this key, if carried to a mainnet deployment unchanged, would be able to change who is authorized and to upgrade the registry, bank and pools.
//
// Keyless and read-only: view reads, storage reads, bytecode reads and (section 4, clearly labelled) eth_call simulations of an upgrade to the
// SAME implementation. Nothing is signed, sent or persisted. Node 18+, viem is the only dependency (`npm install`).
//
//   node feedback-repro-03.mjs
//   PIN_BLOCK=<n> node feedback-repro-03.mjs     re-run at a specific past block (needs an RPC serving that state)

import { createPublicClient, http, decodeErrorResult, encodeFunctionData, getAddress, isAddressEqual, parseAbi, toFunctionSelector } from "viem";

// ---------------------------------------------------------------- network and (public) addresses
const RPC = "https://api.hideki2.infra.testnet.somnia.network"; // Somnia Tokyo testnet (Hideki), chain 50383
const CHAIN = { id: 50383, name: "Somnia Hideki testnet", nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
const TARGETS = [
  { key: "registry", label: "OperatorPermissionsRegistry", address: "0x6B2FbfeD328FF5F20C0BE7D3C3437613aFFE8D3a", role: "decides which operator may act for which account" },
  { key: "bank", label: "MarginBank", address: "0x478769E1177C0773c43A593DCCc4Ad15F15F1394", role: "holds all users' perp collateral" },
  { key: "pool", label: "PerpPool (ETH)", address: "0xd6cb1dd58580b84d76068ac21594219ce03aeddf", role: "the ETH/USDso market (a beacon proxy)" },
  { key: "factory", label: "PerpPoolFactory", address: "0xE631fAEE547baeE07353E290f0562ea67d856560", role: "creates perp pools" },
];
const EIP1967 = {
  impl: "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
  beacon: "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50",
  admin: "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103",
};
const NEUTRAL = "0x1111111111111111111111111111111111111111"; // an address with no role anywhere
const ZERO = "0x0000000000000000000000000000000000000000";

const VIEWS = parseAbi([
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function implementation() view returns (address)",
  "function getSystemConfig() view returns ((address marginBank, address collateralToken, address perpPoolFactory, address liquidationEngine, address insuranceFund, address feeRecipient, uint16 maxLeverageLimit, bool fullyWired))",
]);
const UPGRADE_UUPS = parseAbi(["function upgradeToAndCall(address newImplementation, bytes data)"]);
const UPGRADE_BEACON = parseAbi(["function upgradeTo(address newImplementation)"]);
const ERRS = parseAbi([
  "error OwnableUnauthorizedAccount(address account)", "error Error(string)", "error Panic(uint256)",
  "error UUPSUnauthorizedCallContext()", "error UUPSUnsupportedProxiableUUID(bytes32 slot)",
  "error ERC1967InvalidImplementation(address implementation)", "error ERC1967NonPayable()",
]);
// admin-surface selectors we look for in each implementation's bytecode
const ADMIN_SELECTORS = {
  "owner()": toFunctionSelector("function owner()"),
  "pendingOwner()": toFunctionSelector("function pendingOwner()"),
  "transferOwnership(address)": toFunctionSelector("function transferOwnership(address)"),
  "acceptOwnership()": toFunctionSelector("function acceptOwnership()"),
  "renounceOwnership()": toFunctionSelector("function renounceOwnership()"),
  "upgradeToAndCall(address,bytes)": toFunctionSelector("function upgradeToAndCall(address,bytes)"),
  "proxiableUUID()": toFunctionSelector("function proxiableUUID()"),
  "upgradeTo(address)": toFunctionSelector("function upgradeTo(address)"),
};

const client = createPublicClient({ chain: CHAIN, transport: http(RPC) });
const line = (s = "") => console.log(s);
const short = (a) => `${a.slice(0, 8)}…${a.slice(-6)}`;
const hex = (n) => `0x${n.toString(16)}`;
let block;

const read = async (address, functionName, args = []) => { try { return await client.readContract({ address, abi: VIEWS, functionName, args, blockNumber: block }); } catch { return null; } };
const slotAddr = async (address, slot) => { const v = await client.getStorageAt({ address, slot, blockNumber: block }); if (!v || v === "0x") return null; const a = `0x${v.slice(2).padStart(64, "0").slice(-40)}`; return /^0x0{40}$/.test(a) ? null : getAddress(a); };
const codeOf = async (address) => ((await client.getCode({ address, blockNumber: block })) ?? "0x").toLowerCase();
function revertData(e) { const seen = new Set(); for (let x = e; x && !seen.has(x); x = x.cause) { seen.add(x); for (const k of ["data", "raw"]) if (typeof x[k] === "string" && /^0x[0-9a-fA-F]*$/.test(x[k])) return x[k]; if (typeof x.data?.data === "string" && /^0x/.test(x.data.data)) return x.data.data; } return null; }
async function simulate(from, to, abi, functionName, args) {
  try { await client.call({ account: from, to, data: encodeFunctionData({ abi, functionName, args }), blockNumber: block, gas: 10_000_000n }); return "SUCCESS (no revert)"; }
  catch (e) {
    const raw = revertData(e);
    if (!raw || raw === "0x") return "REVERT (empty)";
    try { const d = decodeErrorResult({ abi: ERRS, data: raw }); return `REVERT ${d.errorName}${d.errorName === "Error" ? `("${d.args[0]}")` : ""}`; } catch { return `REVERT (selector ${raw.slice(0, 10)})`; }
  }
}
// classify an address: EOA / contract, nonce, and Safe-like probe
async function classify(address) {
  const code = await codeOf(address);
  const nonce = await client.getTransactionCount({ address, blockNumber: block });
  if (code === "0x") return { kind: "EOA", text: `EOA (no code; ${nonce} txs sent by this key)`, isEoa: true };
  const owners = await read(address, "getOwners"), threshold = await read(address, "getThreshold");
  if (owners) return { kind: "Safe-like", text: `contract, Safe-like multisig: ${threshold}-of-${owners.length} (${owners.map(short).join(", ")})`, isEoa: false };
  const inner = await read(address, "owner");
  return { kind: "contract", text: `contract (${(code.length - 2) / 2} bytes${inner ? `, itself owned by ${short(inner)}` : ""}); NOT a recognised Safe`, isEoa: false };
}

// =====================================================================================================
line("feedback-repro-03: who controls the authorization / upgrade path of the perp system?  (testnet observation)");
line("=".repeat(96));
block = process.env.PIN_BLOCK ? BigInt(process.env.PIN_BLOCK) : await client.getBlockNumber();
line(`Pinned block: ${block}${process.env.PIN_BLOCK ? " (set via PIN_BLOCK)" : ""}   chain ${CHAIN.id}`);
line("Reads and eth_call simulations only. No key, no signature, no transaction.");

// ---------------------------------------------------------------- 1. proxy structure
line("\n1. Proxy structure (EIP-1967 slots) and the contract whose code actually runs");
const info = {};
for (const t of TARGETS) {
  const code = await codeOf(t.address);
  const impl = await slotAddr(t.address, EIP1967.impl), beacon = await slotAddr(t.address, EIP1967.beacon), admin = await slotAddr(t.address, EIP1967.admin);
  let implementation = impl, how = impl ? "EIP-1967 implementation slot" : null, beaconImplCode = null;
  if (!implementation && beacon) { implementation = await read(beacon, "implementation"); how = `EIP-1967 beacon slot -> beacon ${beacon}`; }
  info[t.key] = { ...t, code, impl: implementation, beacon, adminSlot: admin };
  line(`   ${t.label.padEnd(30)} ${t.address}`);
  line(`      ${t.role}`);
  line(`      code ${(code.length - 2) / 2} bytes; ${implementation ? `proxy -> implementation ${implementation} (via ${how})` : "no EIP-1967 implementation/beacon slot set (not a proxy, or a non-standard one)"}${admin ? `; EIP-1967 admin slot = ${admin}` : ""}`);
}
const beaconAddr = info.pool.beacon;
if (beaconAddr) {
  const bcode = await codeOf(beaconAddr);
  info.beacon = { key: "beacon", label: "PerpPool beacon", address: beaconAddr, role: "supplies the implementation for EVERY beacon-proxied pool", code: bcode, impl: null, beacon: null, adminSlot: null };
  line(`   ${"PerpPool beacon".padEnd(30)} ${beaconAddr}`);
  line(`      supplies the implementation for every pool that points at it; code ${(bcode.length - 2) / 2} bytes`);
}

// ---------------------------------------------------------------- 2. owners
line("\n2. Owner of each contract, and what kind of account that owner is");
const rows = [];
const subjects = [...TARGETS.map((t) => info[t.key]), ...(info.beacon ? [info.beacon] : [])];
for (const s of subjects) {
  const owner = await read(s.address, "owner"), pending = await read(s.address, "pendingOwner");
  const c = owner ? await classify(owner) : null;
  rows.push({ ...s, owner, pending, c });
  line(`   ${s.label.padEnd(30)} owner() = ${owner ?? "(no owner() getter)"}`);
  if (c) line(`      owner is: ${c.text}`);
  line(`      pendingOwner() = ${pending === null ? "(no getter)" : isAddressEqual(pending, ZERO) ? "0x0 (no ownership transfer pending)" : pending}`);
  if (s.adminSlot) line(`      EIP-1967 proxy admin = ${s.adminSlot}${(await codeOf(s.adminSlot)) === "0x" ? " (EOA)" : " (contract)"}`);
}

// ---------------------------------------------------------------- 3. admin surface in the implementation code
line("\n3. Admin / upgrade surface present in each implementation's bytecode (selector presence only; access control is tested in section 4)");
const codeFor = { registry: info.registry.impl, bank: info.bank.impl, pool: info.pool.impl, factory: info.factory.impl ?? info.factory.address, beacon: beaconAddr };
const names = Object.keys(ADMIN_SELECTORS);
const cols = Object.entries(codeFor).filter(([, a]) => a).map(([k]) => k);
const colTitle = { registry: "registry", bank: "bank", pool: "pool(ETH)", factory: "factory", beacon: "beacon" };
const presence = {};
for (const k of cols) { const c = await codeOf(codeFor[k]); presence[k] = Object.fromEntries(names.map((n) => [n, c.includes(ADMIN_SELECTORS[n].slice(2))])); }
line(`   ${"selector".padEnd(34)} ${cols.map((k) => colTitle[k].padEnd(11)).join(" ")}`);
for (const n of names) line(`   ${n.padEnd(34)} ${cols.map((k) => (presence[k][n] ? "yes" : "-").padEnd(11)).join(" ")}`);
line("   (the code inspected is each proxy's implementation; for the beacon and, if it is not a proxy, the factory, the contract's own code)");

// ---------------------------------------------------------------- 4. upgrade authority, by simulation
line("\n4. Upgrade authority, by SIMULATION");
line("   Each call is an eth_call at the pinned block that upgrades a contract to ITS OWN CURRENT implementation, i.e. a no-op even if it were executed.");
line("   Nothing is sent or changed. It shows which `from` address the contract treats as authorized to upgrade it.");
const upgradeTests = [];
for (const r of rows) {
  if (!r.owner) continue;
  const code = r.key === "beacon" ? await codeOf(r.address) : codeFor[r.key] ? await codeOf(codeFor[r.key]) : "0x";
  const hasUups = code.includes(ADMIN_SELECTORS["upgradeToAndCall(address,bytes)"].slice(2));
  const hasBeaconUpgrade = r.key === "beacon" && code.includes(ADMIN_SELECTORS["upgradeTo(address)"].slice(2));
  let target = null, abi, fn, args;
  if (r.key === "beacon" && hasBeaconUpgrade) { target = r.address; abi = UPGRADE_BEACON; fn = "upgradeTo"; args = [await read(r.address, "implementation")]; }
  else if (r.key !== "beacon" && r.key !== "pool" && r.impl && hasUups) { target = r.address; abi = UPGRADE_UUPS; fn = "upgradeToAndCall"; args = [r.impl, "0x"]; }
  else if (r.key === "factory" && !r.impl && hasUups) { target = r.address; abi = UPGRADE_UUPS; fn = "upgradeToAndCall"; args = [r.address, "0x"]; }
  if (!target || !args[0]) { line(`   ${r.label.padEnd(30)} no standard upgrade function found; not simulated${r.key === "pool" ? " (a beacon-proxy pool is upgraded through its beacon, below)" : ""}`); continue; }
  const asOwner = await simulate(r.owner, target, abi, fn, args);
  const asNeutral = await simulate(NEUTRAL, target, abi, fn, args);
  upgradeTests.push({ label: r.label, asOwner, asNeutral });
  line(`   ${r.label.padEnd(30)} ${fn}(current implementation)`);
  line(`      from the owner ${short(r.owner)}: ${asOwner}`);
  line(`      from a neutral address:        ${asNeutral}`);
}

// ---------------------------------------------------------------- 5. fee recipient and the other system contracts
line("\n5. MarginBank system config, and whether the same address is the fee recipient");
const cfg = await read(info.bank.address, "getSystemConfig");
const bankOwner = rows.find((r) => r.key === "bank")?.owner;
if (cfg) {
  line(`   feeRecipient     = ${cfg.feeRecipient}${bankOwner ? `   same as MarginBank owner: ${isAddressEqual(cfg.feeRecipient, bankOwner)}` : ""}`);
  line(`   liquidationEngine = ${cfg.liquidationEngine}`);
  line(`   insuranceFund     = ${cfg.insuranceFund}`);
  line(`   perpPoolFactory   = ${cfg.perpPoolFactory}   (matches the factory above: ${isAddressEqual(cfg.perpPoolFactory, info.factory.address)})`);
  line("   Extra system contracts (not in the original list), owners:");
  for (const [n, a] of [["liquidationEngine", cfg.liquidationEngine], ["insuranceFund", cfg.insuranceFund]]) {
    const o = await read(a, "owner"); const c = o ? await classify(o) : null;
    rows.push({ key: n, label: n, address: a, owner: o, c, extra: true });
    line(`      ${n.padEnd(18)} owner() = ${o ?? "(no owner() getter)"}${c ? `   -> ${c.kind}` : ""}`);
  }
} else line("   getSystemConfig() unavailable at this block; fee recipient not re-verified.");

// ---------------------------------------------------------------- 6. conclusion
line("\n6. Conclusion");
line("=".repeat(96));
const core = rows.filter((r) => !r.extra && r.owner);
const distinct = [...new Set(core.map((r) => r.owner.toLowerCase()))];
const allEoa = core.every((r) => r.c?.isEoa);
const withExtra = rows.filter((r) => r.owner);
const distinctExtra = [...new Set(withExtra.map((r) => r.owner.toLowerCase()))];
const missing = TARGETS.filter((t) => !rows.find((r) => r.key === t.key)?.owner).map((t) => t.label);
if (missing.length) line(`NOTE: no owner() could be read for: ${missing.join(", ")}.`);
if (distinct.length === 1 && allEoa) {
  const upOk = upgradeTests.length > 0 && upgradeTests.every((u) => u.asOwner.startsWith("SUCCESS") && !u.asNeutral.startsWith("SUCCESS"));
  const twoStep = cols.filter((k) => presence[k]["pendingOwner()"] && presence[k]["acceptOwnership()"]).map((k) => colTitle[k]);
  const oneStep = cols.filter((k) => !(presence[k]["pendingOwner()"] && presence[k]["acceptOwnership()"])).map((k) => colTitle[k]);
  line(`Observed: ONE externally-owned account, ${getAddress(distinct[0])},`);
  line(`is the owner of all ${core.length} listed contracts (${core.map((r) => r.label).join(", ")})${distinctExtra.length === 1 ? ", and of the liquidation engine and insurance fund as well" : ""}.`);
  line(`It is a plain EOA (no code), not a multisig or timelock${cfg && bankOwner && isAddressEqual(cfg.feeRecipient, bankOwner) ? "; the same address is also the bank's fee recipient (read from getSystemConfig)" : ""}.`);
  if (upgradeTests.length) line(`In the section 4 simulations ${upOk ? "this owner is accepted as upgrade authority on every contract tested, and a neutral address is not" : "the results were mixed (see section 4)"}.`);
  line(`Ownership transfer is two-step (pendingOwner + acceptOwnership present) on: ${twoStep.join(", ") || "none"}${oneStep.length ? `; not on: ${oneStep.join(", ")}` : ""}.`);
  line("");
  line("Context: a single-EOA admin is normal and expected on a testnet, and this is not a vulnerability here. The note is for mainnet readiness: if this key, or");
  line("this ownership layout, were carried to mainnet unchanged, one key compromise or mistake could upgrade the registry (and with it change which operators are");
  line("authorized), the collateral-holding bank, the factory and every beacon-proxied pool. Suggested before mainnet: a multisig (optionally behind a timelock) as");
  line("owner of all of them, and documenting who holds upgrade authority.");
} else {
  line(`Observed: the ${core.length} listed contracts do NOT all share one EOA owner. Distinct owners: ${distinct.map((a) => getAddress(a)).join(", ")}.`);
  for (const r of core) line(`   ${r.label.padEnd(30)} ${r.owner}  ${r.c?.text ?? ""}`);
  line("Nothing in this run supports a single-EOA conclusion; read the per-contract results in section 2 as they are.");
}
