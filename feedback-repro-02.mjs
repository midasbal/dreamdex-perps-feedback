// feedback-repro-02.mjs
//
// REPRO: the ETH perp pool implements owner-parameterised operator functions that the SDK
// (@somnia-chain/markets-sdk@0.32.1) and the dreamDEX bot-kit never expose and that neither ships documentation for:
//
//     cancelOrdersFor   reduceOrdersFor   amendOrderFor   cancelAllOrdersFor
//
// They ARE correctly access-controlled. This is NOT a security bug. The item is completeness: an integrator who
// follows the SDK / bot-kit surface cannot learn that these functions exist, or which operator grant each needs.
//
// Keyless and read-only: bytecode reads, storage reads and eth_call simulations, all at one pinned block.
// No private key, no signer, no transaction. Node 18+, viem only (`npm install`). Section 2 also downloads two
// public tarballs and scans them in memory (nothing is written to disk or executed).
//
//   node feedback-repro-02.mjs
//   PIN_BLOCK=<n> node feedback-repro-02.mjs     re-run at a specific past block (needs an RPC serving that state)

import { gunzipSync } from "node:zlib";
import { createPublicClient, http, decodeErrorResult, encodeFunctionData, getAddress, parseAbi, toFunctionSelector } from "viem";

// ---------------------------------------------------------------- network and (public) addresses
const RPC = "https://api.hideki2.infra.testnet.somnia.network"; // Somnia Tokyo testnet (Hideki), chain 50383
const CHAIN = { id: 50383, name: "Somnia Hideki testnet", nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
const POOL = "0xd6cb1dd58580b84d76068ac21594219ce03aeddf"; // ETH/USDso perp pool (a beacon proxy)
const SAFE = "0x9b29D1086BCa079CC07b859B406b84E5b8c9e7B1"; // account that authorized the operator below, with all three standard grants
const OPERATOR = "0x47a34Ad5b25dF3887Bde8FC7C20c4711495D568D"; // that operator (public address; only impersonated via eth_call)
const REGISTRY = "0x6B2FbfeD328FF5F20C0BE7D3C3437613aFFE8D3a"; // OperatorPermissionsRegistry the pool consults
const SDK_TARBALL = "https://registry.npmjs.org/@somnia-chain/markets-sdk/-/markets-sdk-0.32.1.tgz";
const BOTKIT_TARBALL = "https://codeload.github.com/somnia-chain/dreamdex-bot-kit/tar.gz/25798660bbe4674a6f83a960b202852896e2fed4"; // pinned commit
const EIP1967_IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const EIP1967_BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";
const ZERO = "0x0000000000000000000000000000000000000000";
const MISSING_ORDER_ID = 1n; // any id works: we only care whether the call gets PAST the authorization gate

// ---------------------------------------------------------------- the functions under test
// The four undocumented signatures are reconstructed by analogy with the documented ones. The evidence they are right is
// that their 4-byte selectors are present in the implementation bytecode (section 1) and that the calls decode and dispatch (section 3).
const NEW_REQ = "(bool isBid, uint64 userData, uint256 price, uint256 quantity, uint64 expireTimestampNs, uint8 orderType, uint8 selfMatchingOption, address builder, uint96 builderFeeBpsTimes1k)";
const FUNCS = [
  { name: "placeOrderFor", label: "placeFor", documented: true, sig: "function placeOrderFor(address owner, bool isBid, uint64 userData, uint256 price, uint256 quantity, uint64 expireTimestampNs, uint8 orderType, uint8 selfMatchingOption, address builder, uint96 builderFeeBpsTimes1k) returns (bool success, uint128 orderId)", args: () => [SAFE, true, 0n, 1_000_000_000_000_000_000n, 4_000_000_000_000_000n, 4_000_000_000_000_000_000n, 3, 0, ZERO, 0n] },
  { name: "cancelOrderFor", label: "cancelFor", documented: true, sig: "function cancelOrderFor(address owner, uint128 orderId)", args: () => [SAFE, MISSING_ORDER_ID] },
  { name: "reduceOrderFor", label: "reduceFor", documented: true, sig: "function reduceOrderFor(address owner, uint128 orderId, uint256 newQuantityRemaining)", args: () => [SAFE, MISSING_ORDER_ID, 1n] },
  { name: "cancelOrdersFor", label: "cancelMany", documented: false, sig: "function cancelOrdersFor(address owner, uint128[] ids)", args: () => [SAFE, [MISSING_ORDER_ID]] },
  { name: "reduceOrdersFor", label: "reduceMany", documented: false, sig: "function reduceOrdersFor(address owner, (uint128 orderId, uint256 newQuantityRemaining)[] requests)", args: () => [SAFE, [{ orderId: MISSING_ORDER_ID, newQuantityRemaining: 1n }]] },
  { name: "amendOrderFor", label: "amendFor", documented: false, sig: `function amendOrderFor(address owner, (uint128 oldOrderId, bool alwaysPlace, ${NEW_REQ} newOrder) request)`, args: () => [SAFE, { oldOrderId: MISSING_ORDER_ID, alwaysPlace: false, newOrder: { isBid: true, userData: 0n, price: 1_000_000_000_000_000_000n, quantity: 4_000_000_000_000_000n, expireTimestampNs: 4_000_000_000_000_000_000n, orderType: 0, selfMatchingOption: 0, builder: ZERO, builderFeeBpsTimes1k: 0n } }] },
  { name: "cancelAllOrdersFor", label: "cancelAll", documented: false, sig: "function cancelAllOrdersFor(address owner)", args: () => [SAFE] },
];
for (const f of FUNCS) { f.abi = parseAbi([f.sig]); f.selector = toFunctionSelector(f.abi[0]); }
const ERRORS = parseAbi(["error OnlyApprovedContracts()", "error OnlyMarginBank()", "error IncorrectSender(address sender, address expected)", "error IncorrectOrder()", "error AmendOldOrderGone(uint128 oldOrderId)"]);
const VIEW_ABI = parseAbi(["function isOperatorAuthorized(address owner, address operator, bytes4 selector) view returns (bool)", "function implementation() view returns (address)"]);
const STD = { place: FUNCS[0].selector, cancel: FUNCS[1].selector, reduce: FUNCS[2].selector }; // the three grants the app writes

const client = createPublicClient({ chain: CHAIN, transport: http(RPC) });
const line = (s = "") => console.log(s);
const short = (a) => `${a.slice(0, 8)}…${a.slice(-6)}`;
const hex = (n) => `0x${n.toString(16)}`;

function revertData(e) {
  const seen = new Set();
  for (let x = e; x && !seen.has(x); x = x.cause) {
    seen.add(x);
    for (const k of ["data", "raw"]) if (typeof x[k] === "string" && /^0x[0-9a-fA-F]*$/.test(x[k])) return x[k];
    if (typeof x.data?.data === "string" && /^0x/.test(x.data.data)) return x.data.data;
  }
  return null;
}
// One eth_call; optional storage override on the registry. Returns { name } = "SUCCESS" or the revert's error name.
async function sim(block, from, f, stateDiff) {
  const data = encodeFunctionData({ abi: f.abi, functionName: f.name, args: f.args() });
  try {
    await client.call({ account: from, to: POOL, data, blockNumber: block, gas: 10_000_000n, ...(stateDiff ? { stateOverride: [{ address: REGISTRY, stateDiff }] } : {}) });
    return { name: "SUCCESS" };
  } catch (e) {
    const raw = revertData(e);
    if (!raw || raw === "0x") return { name: "REVERT(empty)" };
    try { return { name: decodeErrorResult({ abi: ERRORS, data: raw }).errorName }; } catch { return { name: `REVERT(${raw.slice(0, 10)})` }; }
  }
}

// minimal in-memory tar reader (ustar + pax path records)
function* tarFiles(buf) {
  let off = 0, paxPath = null;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const str = (a, b) => { const s = h.subarray(a, b); const z = s.indexOf(0); return s.subarray(0, z < 0 ? s.length : z).toString("utf8"); };
    let name = str(0, 100);
    const prefix = str(345, 500), size = parseInt(str(124, 136).trim() || "0", 8), type = h[156] === 0 ? "0" : String.fromCharCode(h[156]);
    const data = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === "x") { const m = /\d+ path=([^\n]*)\n/.exec(data.toString("utf8")); if (m) paxPath = m[1]; continue; }
    if (type === "g") continue;
    if (paxPath) { name = paxPath; paxPath = null; } else if (prefix) name = `${prefix}/${name}`;
    if (type === "0") yield { name, data };
  }
}
function countIn(buf, needle) { const n = Buffer.from(needle); let c = 0, i = 0; while ((i = buf.indexOf(n, i)) !== -1) { c++; i += n.length; } return c; }
async function scanTarball(url, needles) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const tar = gunzipSync(Buffer.from(await res.arrayBuffer()));
  const out = Object.fromEntries(needles.map((n) => [n, { total: 0, files: [] }]));
  let nFiles = 0;
  for (const { name, data } of tarFiles(tar)) {
    nFiles++;
    for (const n of needles) { const c = countIn(data, n); if (c) { out[n].total += c; out[n].files.push(name); } }
  }
  return { out, nFiles };
}

// =====================================================================================================
line("feedback-repro-02: undocumented owner-parameterised operator functions on the perp pool");
line("=".repeat(92));
const block = process.env.PIN_BLOCK ? BigInt(process.env.PIN_BLOCK) : await client.getBlockNumber();
line(`Pinned block: ${block}${process.env.PIN_BLOCK ? " (set via PIN_BLOCK)" : ""}   chain ${CHAIN.id}   pool ${POOL}`);
line("Everything below is a read or an eth_call at that block. No key, no signature, no transaction.");

// ---------------------------------------------------------------- 1. selectors vs implementation bytecode
line("\n1. Selectors, and whether each is present in the pool's implementation bytecode");
const poolCode = (await client.getCode({ address: POOL, blockNumber: block })) ?? "0x";
const slotAddr = async (slot) => { const v = await client.getStorageAt({ address: POOL, slot, blockNumber: block }); if (!v || v === "0x") return null; const a = `0x${v.slice(2).padStart(64, "0").slice(-40)}`; return /^0x0{40}$/.test(a) ? null : getAddress(a); };
let impl = await slotAddr(EIP1967_IMPL_SLOT), how = "EIP-1967 implementation slot";
if (!impl) {
  const beacon = await slotAddr(EIP1967_BEACON_SLOT);
  if (beacon) { impl = await client.readContract({ address: beacon, abi: VIEW_ABI, functionName: "implementation", blockNumber: block }); how = `EIP-1967 beacon slot -> beacon ${short(beacon)}.implementation()`; }
}
if (!impl) { line("   could not resolve the implementation; stopping."); process.exit(1); }
const implCode = ((await client.getCode({ address: impl, blockNumber: block })) ?? "0x").toLowerCase();
line(`   pool is a proxy (${(poolCode.length - 2) / 2} bytes); implementation ${impl} resolved via ${how}; implementation code ${(implCode.length - 2) / 2} bytes`);
const bogus = { name: "bogusFunctionForControl", documented: null, selector: toFunctionSelector("function bogusFunctionForControl()") };
line(`   ${"function".padEnd(24)} ${"selector".padEnd(11)} ${"in implementation".padEnd(18)} role`);
for (const f of [...FUNCS, bogus]) {
  const present = implCode.includes(`63${f.selector.slice(2)}`); // PUSH4 <selector>, as in the dispatcher
  const role = f.documented === null ? "ABSENT-control (made-up name)" : f.documented ? "present-control (the 3 standard operator functions)" : "under test (undocumented)";
  line(`   ${f.name.padEnd(24)} ${f.selector.padEnd(11)} ${(present ? "PRESENT" : "absent").padEnd(18)} ${role}`);
}

// ---------------------------------------------------------------- 2. SDK / bot-kit surface
line("\n2. Does the SDK or the bot-kit expose them?  (in-memory scan of two pinned public tarballs)");
const names = FUNCS.map((f) => f.name);
const needles = [...names, ...names.map((n) => `function ${n}(`)]; // bare name, and an ABI entry for the function
const packages = [["@somnia-chain/markets-sdk@0.32.1 (src, dist, docs, README)", SDK_TARBALL], ["dreamdex-bot-kit @ 2579866 (all files incl. docs/, skills/)", BOTKIT_TARBALL]];
for (const [label, url] of packages) {
  line(`   ${label}`);
  try {
    const { out, nFiles } = await scanTarball(url, needles);
    line(`   scanned ${nFiles} files.   ${"function".padEnd(22)} ${"mentions".padEnd(9)} ABI entry "function NAME("`);
    for (const f of FUNCS) {
      const m = out[f.name], a = out[`function ${f.name}(`];
      line(`   ${"".padEnd(19)} ${f.name.padEnd(22)} ${String(m.total).padEnd(9)} ${a.total ? `yes (${a.files[0]})` : "none"}${f.documented ? "" : "   <- under test"}`);
    }
  } catch (e) { line(`   (could not fetch/scan: ${e.message}; skipped)`); }
}
line("   Reading: the SDK package contains no ABI entry (so it cannot encode a call) for ANY of the seven `...For` functions; its remaining mentions");
line("   of the three standard ones are not ABI entries. The bot-kit has ABI entries and wrappers for the three standard ones only. The four under");
line("   test have ZERO mentions of any kind in either package, including the SDK's shipped docs/ and README and the bot-kit's docs/ and skills/.");
line("   (Scope: these two packages only. The hosted developer docs site is not scanned here.)");

// ---------------------------------------------------------------- 3. what grant does each need?  (EMULATION)
line("\n3. Which operator grant does each need?");
line("   *** EMULATION via eth_call state override, NOT a real partial grant. ***");
line(`   The operator ${short(OPERATOR)} really holds all three standard grants from ${short(SAFE)}. In each simulation the registry's`);
line("   storage slots for some of those grants are zeroed (for that one call only; nothing is written) to emulate an operator that holds a subset.");
let matrixState = "skipped";
try {
  // find the registry storage slot behind each grant
  const slots = {};
  for (const [g, sel] of Object.entries(STD)) {
    const tr = await client.request({ method: "debug_traceCall", params: [{ to: POOL, data: encodeFunctionData({ abi: VIEW_ABI, functionName: "isOperatorAuthorized", args: [SAFE, OPERATOR, sel] }) }, hex(block), { tracer: "prestateTracer", tracerConfig: { diffMode: false } }] });
    const st = Object.entries(tr).find(([a]) => a.toLowerCase() === REGISTRY.toLowerCase())?.[1]?.storage ?? {};
    slots[g] = Object.entries(st).filter(([k, v]) => BigInt(v) !== 0n && k.toLowerCase() !== EIP1967_IMPL_SLOT).map(([k]) => k);
  }
  const tally = {}; Object.values(slots).flat().forEach((s) => (tally[s] = (tally[s] ?? 0) + 1));
  for (const g of Object.keys(slots)) slots[g] = slots[g].filter((s) => tally[s] === 1);
  if (Object.values(slots).some((s) => s.length !== 1)) throw new Error(`expected exactly one grant slot per standard selector, found ${JSON.stringify(Object.fromEntries(Object.entries(slots).map(([k, v]) => [k, v.length])))}`);
  line(`   located one registry storage slot per standard grant: place ${slots.place[0].slice(0, 12)}…  cancel ${slots.cancel[0].slice(0, 12)}…  reduce ${slots.reduce[0].slice(0, 12)}…`);

  const subsets = [["place", "cancel", "reduce"], ["place"], ["cancel"], ["reduce"], ["place", "cancel"], ["place", "reduce"], ["cancel", "reduce"], []];
  const diffFor = (sub) => Object.entries(slots).filter(([g]) => !sub.includes(g)).map(([, s]) => ({ slot: s[0], value: `0x${"0".repeat(64)}` }));
  const cell = (r) => (r.name === "OnlyApprovedContracts" ? "deny" : r.name === "OnlyMarginBank" ? "BANK-ONLY" : "pass");
  const heads = FUNCS.map((f) => f.label.padEnd(11));
  line("       columns: " + FUNCS.map((f) => `${f.label}=${f.name}`).join("  "));

  // (a) prove the emulation does what we say: resolved grants per subset
  line("\n   (a) emulation check: pool.isOperatorAuthorized(SAFE, OPERATOR, selector) under each override");
  let emuOk = true;
  for (const sub of subsets) {
    const got = {};
    for (const [g, sel] of Object.entries(STD)) got[g] = await client.readContract({ address: POOL, abi: VIEW_ABI, functionName: "isOperatorAuthorized", args: [SAFE, OPERATOR, sel], blockNumber: block, stateOverride: [{ address: REGISTRY, stateDiff: diffFor(sub) }] });
    const ok = Object.keys(STD).every((g) => got[g] === sub.includes(g)); emuOk &&= ok;
    line(`       intended ${(sub.join("+") || "(none)").padEnd(20)} -> resolved place=${got.place} cancel=${got.cancel} reduce=${got.reduce}   ${ok ? "ok" : "MISMATCH"}`);
  }
  if (!emuOk) throw new Error("emulation did not produce the intended grants; matrix not trustworthy");

  // (b) the matrix
  line("\n   (b) gate result per function.  deny = OnlyApprovedContracts;  pass = got PAST the authorization gate (later outcome is irrelevant: the id does not exist);  BANK-ONLY = OnlyMarginBank");
  line(`       ${"operator holds".padEnd(20)} ${heads.join(" ")}`);
  const rows = {};
  for (const sub of subsets) {
    const row = {};
    for (const f of FUNCS) row[f.name] = cell(await sim(block, OPERATOR, f, diffFor(sub)));
    rows[sub.join("+") || "(none)"] = row;
    line(`       ${(sub.join("+") || "(none)").padEnd(20)} ${FUNCS.map((f) => row[f.name].padEnd(11)).join(" ")}`);
  }

  // (c) built-in sanity check
  const none = rows["(none)"];
  const grantable = FUNCS.filter((f) => f.name !== "cancelAllOrdersFor");
  const sanityOk = grantable.every((f) => none[f.name] === "deny");
  line(`\n   (c) SANITY CHECK: with zero grants, every operator-grantable function denies: ${grantable.filter((f) => none[f.name] === "deny").length}/${grantable.length} deny  ->  ${sanityOk ? "ok" : "FAILED"}`);
  line(`       cancelAllOrdersFor with zero grants: ${none.cancelAllOrdersFor}   (and with all three grants: ${rows["place+cancel+reduce"].cancelAllOrdersFor})`);

  // (d) derived requirement and comparison with expectation
  const expected = { placeOrderFor: "place", cancelOrderFor: "cancel", reduceOrderFor: "reduce", cancelOrdersFor: "cancel", reduceOrdersFor: "reduce", amendOrderFor: "place+cancel", cancelAllOrdersFor: "BANK-ONLY" };
  line("\n   (d) minimal grant set that passes the gate, derived from the matrix (vs. what the naming suggests)");
  let allMatch = sanityOk;
  for (const f of FUNCS) {
    let derived;
    if (rows["place+cancel+reduce"][f.name] === "BANK-ONLY" && none[f.name] === "BANK-ONLY") derived = "BANK-ONLY";
    else {
      const pass = Object.entries(rows).filter(([k, r]) => r[f.name] === "pass" && k !== "(none)").map(([k]) => k);
      const minimal = pass.filter((k) => !pass.some((j) => j !== k && j.split("+").every((p) => k.split("+").includes(p)) && j.split("+").length < k.split("+").length));
      derived = minimal.join(" | ") || "none";
    }
    const ok = derived === expected[f.name]; allMatch &&= ok;
    line(`       ${f.name.padEnd(20)} needs: ${derived.padEnd(14)} expected: ${expected[f.name].padEnd(13)} ${ok ? "match" : "DIFFERS"}   ${f.documented ? "(standard)" : "(undocumented)"}`);
  }
  matrixState = allMatch ? "match" : "mismatch";
} catch (e) {
  line(`   section 3 skipped: ${e.message}`);
  line("   (it needs an RPC that supports debug_traceCall with prestateTracer and eth_call state overrides at the pinned block)");
}

// ---------------------------------------------------------------- 4. summary
line("\n4. Summary");
line("=".repeat(92));
line(
  `These four owner-parameterised functions exist on the ETH perp pool (selectors present in the implementation bytecode, section 1) and are\n` +
    `properly gated: in the emulation, cancelOrdersFor needs only the cancel grant, reduceOrdersFor only the reduce grant, amendOrderFor needs\n` +
    `place AND cancel, and cancelAllOrdersFor is not operator-grantable at all (margin-bank only)${matrixState === "match" ? "" : matrixState === "skipped" ? " [section 3 was skipped on this RPC, so the grant requirements are NOT re-verified in this run]" : " [see section 3: this run did NOT fully match that expectation]"}. This is NOT a security issue: with\n` +
    `zero grants every grantable function denies. But they are absent from @somnia-chain/markets-sdk@0.32.1 and from the bot-kit, and neither\n` +
    `package's shipped documentation mentions them or the grant each requires, so an integrator following the documented surface cannot discover them.\n` +
    `Suggested fix: document them (including the grant each needs, and that amendOrderFor needs two) or expose wrappers in the SDK.`,
);
