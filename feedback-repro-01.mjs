// feedback-repro-01.mjs
//
// REPRO: on the ETH perp pool, cancelOrder / reduceOrder / reduceOrders called with an order id that
// no longer exists revert with IncorrectSender(...) naming an UNRELATED third-party address as the
// order's owner, instead of a clean "order not found" error. amendOrder, for the same ids, correctly
// reverts with AmendOldOrderGone.
//
// Keyless and read-only: every call is an eth_call (a simulation) pinned to one block. No private key,
// no signer, no transaction is ever created. Requires Node 18+ and `npm install` (viem only).
//
//   node feedback-repro-01.mjs
//
// Optional: PIN_BLOCK=<n> node feedback-repro-01.mjs   re-runs at a specific past block (needs an RPC that serves that state).

import { createPublicClient, http, decodeErrorResult, decodeFunctionData, encodeFunctionData, parseAbi, isAddressEqual } from "viem";

// ---------------------------------------------------------------- network and addresses (all public)
const RPC = "https://api.hideki2.infra.testnet.somnia.network"; // Somnia Tokyo testnet (Hideki), chain 50383
const CHAIN = { id: 50383, name: "Somnia Hideki testnet", nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
const POOL = "0xd6cb1dd58580b84d76068ac21594219ce03aeddf"; // ETH/USDso perp pool
const SAFE = "0x9b29D1086BCa079CC07b859B406b84E5b8c9e7B1"; // the account that owned (and cancelled) order A
const OPERATOR = "0x47a34Ad5b25dF3887Bde8FC7C20c4711495D568D"; // an operator that SAFE authorized for cancelOrderFor (public address; only impersonated via eth_call)
const NEUTRAL = "0x1111111111111111111111111111111111111111"; // an address with no role anywhere
const ZERO = "0x0000000000000000000000000000000000000000";

// Order ids to examine. A is an order we placed for SAFE and then cancelled; its two txs are below.
const PLACE_TX = "0x737a3b06b869e1c2ca682b91696995e2ed80be019c72fbf401900fdef5a3ba05";
const CANCEL_TX = "0xe6aed37efb676d715922872bf599f557ce9e92582094ae3979acc98ffdb9b448";
const IDS = [
  { label: "A (our cancelled order)", id: 10348623425351065400181n, historicalOwner: SAFE },
  { label: "B (another cancelled order)", id: 10348623425351065426342n },
  { label: "C (another cancelled order)", id: 10422410401645903632798n },
];

// ---------------------------------------------------------------- ABIs (minimal)
const POOL_ABI = parseAbi([
  "function getOrder(uint128 orderId) view returns ((uint128 orderId, bool isBid, address owner, uint64 userData, uint256 price, uint256 fullQuantity, uint256 quantityRemaining, uint64 expireTimestampNs))",
  "function cancelOrder(uint128 orderId)",
  "function reduceOrder(uint128 orderId, uint256 newQuantityRemaining)",
  "function reduceOrders((uint128 orderId, uint256 newQuantityRemaining)[] requests)",
  "function cancelOrderFor(address owner, uint128 orderId)",
  "function amendOrder((uint128 oldOrderId, bool alwaysPlace, (bool isBid, uint64 userData, uint256 price, uint256 quantity, uint64 expireTimestampNs, uint8 orderType, uint8 selfMatchingOption, address builder, uint96 builderFeeBpsTimes1k) newOrder) request) returns (uint128 newOrderId)",
]);
const PLACE_FOR_ABI = parseAbi(["function placeOrderFor(address owner, bool isBid, uint64 userData, uint256 price, uint256 quantity, uint64 expireTimestampNs, uint8 orderType, uint8 selfMatchingOption, address builder, uint96 builderFeeBpsTimes1k) returns (bool success, uint128 orderId)"]);
const ERRORS = parseAbi([
  "error IncorrectSender(address sender, address expected)",
  "error IncorrectOrder()",
  "error AmendOldOrderGone(uint128 oldOrderId)",
  "error OnlyApprovedContracts()",
]);

const client = createPublicClient({ chain: CHAIN, transport: http(RPC) });
const short = (a) => `${a.slice(0, 8)}…${a.slice(-6)}`;
const line = (s = "") => console.log(s);

// Pull the raw revert bytes out of whatever shape the RPC/viem error takes.
function revertData(e) {
  const seen = new Set();
  for (let x = e; x && !seen.has(x); x = x.cause) {
    seen.add(x);
    for (const k of ["data", "raw"]) if (typeof x[k] === "string" && /^0x[0-9a-fA-F]*$/.test(x[k])) return x[k];
    if (typeof x.data?.data === "string" && /^0x/.test(x.data.data)) return x.data.data;
  }
  return null;
}

// Run one eth_call at the pinned block and return a decoded outcome.
async function simulate(block, from, functionName, args) {
  const data = encodeFunctionData({ abi: POOL_ABI, functionName, args });
  try {
    await client.call({ account: from, to: POOL, data, blockNumber: block, gas: 10_000_000n });
    return { ok: true, text: "SUCCESS (no revert)" };
  } catch (e) {
    const raw = revertData(e);
    if (!raw || raw === "0x") return { ok: false, text: "REVERT (no data)" };
    try {
      const d = decodeErrorResult({ abi: ERRORS, data: raw });
      if (d.errorName === "IncorrectSender") return { ok: false, name: d.errorName, sender: d.args[0], expected: d.args[1], text: `IncorrectSender(sender=${short(d.args[0])}, expected=${short(d.args[1])})` };
      if (d.errorName === "AmendOldOrderGone") return { ok: false, name: d.errorName, text: `AmendOldOrderGone(oldOrderId=${d.args[0]})` };
      return { ok: false, name: d.errorName, text: `${d.errorName}()` };
    } catch {
      return { ok: false, text: `REVERT (undecoded selector ${raw.slice(0, 10)})` };
    }
  }
}

// =====================================================================================================
line("feedback-repro-01: stale order id => IncorrectSender names an unrelated address");
line("=".repeat(86));

// 1. pin one block
const block = process.env.PIN_BLOCK ? BigInt(process.env.PIN_BLOCK) : await client.getBlockNumber();
line(`1. Pinned block: ${block}${process.env.PIN_BLOCK ? " (set via PIN_BLOCK)" : ""}   (every call below uses blockNumber=${block}; chain ${CHAIN.id}, pool ${POOL})`);
line("   All calls are eth_call simulations from impersonated `from` addresses. No key, no signature, no transaction.");

// 2. confirm each id is gone, using the pool's own view
line("\n2. Confirm each id has no active order (pool.getOrder(id) at the pinned block):");
const gone = [];
for (const item of IDS) {
  let status;
  try {
    const o = await client.readContract({ address: POOL, abi: POOL_ABI, functionName: "getOrder", args: [item.id], blockNumber: block });
    status = `LIVE now (owner ${short(o.owner)}), skipping this id`;
  } catch (e) {
    const raw = revertData(e);
    let name = "";
    try { name = decodeErrorResult({ abi: ERRORS, data: raw }).errorName; } catch {}
    if (name === "IncorrectOrder") { status = "no active order  (getOrder reverts IncorrectOrder)"; gone.push(item); }
    else status = `unexpected getOrder failure (${name || String(raw).slice(0, 10)}), skipping this id`;
  }
  line(`   ${item.label.padEnd(30)} id ${item.id}  ->  ${status}`);
}
if (gone.length === 0) { line("\nNo gone ids available right now. Nothing to demonstrate."); process.exit(0); }

// historical owner of A, from chain data (the place tx's calldata + the pool's OrderPlaced log)
line("\n   Historical owner of A, from the chain:");
const placeTx = await client.getTransaction({ hash: PLACE_TX });
const placeRc = await client.getTransactionReceipt({ hash: PLACE_TX });
const placedOwner = decodeFunctionData({ abi: PLACE_FOR_ABI, data: placeTx.input }).args[0];
const idHex = IDS[0].id.toString(16).padStart(32, "0");
const poolLoggedA = placeRc.logs.some((l) => l.address.toLowerCase() === POOL && l.topics.some((t) => t.includes(idHex)));
line(`   place tx ${PLACE_TX}`);
line(`     placeOrderFor owner argument = ${placedOwner}   (pool logged order A in this tx: ${poolLoggedA})`);
line(`   cancel tx ${CANCEL_TX}`);
line(`     cancelled A for the same owner; on-chain, order A has been gone since that tx.`);

// 3. the calls
line("\n3. Calls on each gone id (all from a neutral address unless noted):");
const named = {}; // id -> set of addresses named by IncorrectSender
for (const item of gone) {
  const id = item.id;
  line(`\n   --- ${item.label}: id ${id}`);
  const rows = [
    ["cancelOrder(id)", NEUTRAL, "cancelOrder", [id]],
    ["reduceOrder(id, 1)", NEUTRAL, "reduceOrder", [id, 1n]],
    ["reduceOrders([{id, 1}])", NEUTRAL, "reduceOrders", [[{ orderId: id, newQuantityRemaining: 1n }]]],
    ["cancelOrderFor(SAFE, id)   [from NEUTRAL: not authorized]", NEUTRAL, "cancelOrderFor", [SAFE, id]],
    ["cancelOrderFor(SAFE, id)   [from OPERATOR: authorized for SAFE]", OPERATOR, "cancelOrderFor", [SAFE, id]],
    ["amendOrder(id -> new order)", NEUTRAL, "amendOrder", [{ oldOrderId: id, alwaysPlace: false, newOrder: { isBid: true, userData: 0n, price: 1_000_000_000_000_000_000n, quantity: 4_000_000_000_000_000n, expireTimestampNs: 4_000_000_000_000_000_000n, orderType: 0, selfMatchingOption: 0, builder: ZERO, builderFeeBpsTimes1k: 0n } }]],
  ];
  for (const [label, from, fn, args] of rows) {
    const r = await simulate(block, from, fn, args);
    line(`   ${label.padEnd(66)} -> ${r.text}`);
    if (r.name === "IncorrectSender") (named[id] ??= new Set()).add(r.expected);
  }
}

// 4. who does IncorrectSender name, and is that the real owner?
line("\n4. Who does IncorrectSender name as the order's owner?");
let unrelatedCount = 0;
for (const item of gone) {
  const names = [...(named[item.id] ?? [])];
  if (names.length === 0) { line(`   ${item.label}: no IncorrectSender observed`); continue; }
  for (const x of names) {
    const isZero = isAddressEqual(x, ZERO);
    const isCaller = isAddressEqual(x, NEUTRAL) || isAddressEqual(x, OPERATOR) || isAddressEqual(x, SAFE);
    line(`   ${item.label}: names ${x}`);
    if (isZero) { line("      zero address (empty slot): not the misleading case; skipping"); continue; }
    if (item.historicalOwner) {
      line(`      historical owner of this id is ${item.historicalOwner} (see the place tx above); named address equals it: ${isAddressEqual(x, item.historicalOwner)}`);
    }
    line(`      pool.getOrder(id) reverts (no active order exists for ANY owner), so ${short(x)} cannot be the owner of an order with this id.`);
    if (!isCaller && (!item.historicalOwner || !isAddressEqual(x, item.historicalOwner))) { unrelatedCount++; line(`      => UNRELATED third-party address reported as the order's owner.`); }
  }
}

// 5. no state change
line("\n5. State change check:");
line("   Every call above is an eth_call: nothing is broadcast, no state changes, and these are reverts, so no events are committed.");
try {
  const probe = gone[0].id;
  const tr = await client.request({ method: "debug_traceCall", params: [{ from: NEUTRAL, to: POOL, data: encodeFunctionData({ abi: POOL_ABI, functionName: "cancelOrder", args: [probe] }), gas: "0x989680" }, `0x${block.toString(16)}`, { tracer: "callTracer", tracerConfig: { withLog: true } }] });
  const logs = []; const walk = (n) => { logs.push(...(n.logs ?? [])); (n.calls ?? []).forEach(walk); }; walk(tr);
  line(`   debug_traceCall of cancelOrder(${probe}) also available on this RPC: reverted=${Boolean(tr.error)}, events emitted=${logs.length}.`);
} catch { line("   (debug_traceCall not available on this RPC; the eth_call result above is sufficient.)"); }

// 6. summary
line("\n6. Summary");
line("=".repeat(86));
line(
  `Expected: calling cancelOrder / reduceOrder / reduceOrders on an order id that does not exist should revert with an\n` +
    `order-not-found style error (as amendOrder does: AmendOldOrderGone, and as the pool's own getOrder view does: IncorrectOrder).\n` +
    `Actual: those three functions revert with IncorrectSender(sender, expected) where \`expected\` is an address that has nothing to do\n` +
    `with the id (${unrelatedCount} of ${gone.length} gone ids named an unrelated third-party address in this run; the named address changes\n` +
    `over time and per id, and is the zero address for ids that never existed). For order A the true historical owner is ${short(SAFE)},\n` +
    `yet the error names a different address. The same happens through cancelOrderFor for an authorized operator. This reads as an authorization\n` +
    `failure and exposes an unrelated address (the owner check appears to run against whichever order now occupies the id's slot before the\n` +
    `id itself is validated; the later IncorrectOrder check prevents any state change, so this is a clarity/error-semantics issue, not an\n` +
    `exploit). Suggested fix: validate the id first and revert with a dedicated order-not-found error.`,
);
