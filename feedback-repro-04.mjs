// feedback-repro-04.mjs
//
// REPRO: MarginBank.getPosition() returns a 4-field struct whose last field, lastUpdatedTimestampNs, the SDK documents as
// "Last position update (nanoseconds)". On the live pool it is 0 on every live position, however recently or long ago the
// position was updated. A consumer that relies on it (a staleness check, a time-since-update calculation) silently gets 0.
//
// Not exploitable: no funds, authorization or state are involved. This is a shipped-surface accuracy issue, in the same family as report 02.
//
// Keyless and read-only: view reads, log reads, storage-trace reads, one indexer query and one public tarball download that is scanned in
// memory. No private key, signer or transaction. Node 18+, viem is the only dependency (`npm install`).
//
//   node feedback-repro-04.mjs                    runs at the RECORDED block (default 28619406), so the output is reproducible
//   PIN_BLOCK=<n> node feedback-repro-04.mjs      any other past block (needs an RPC that serves that state)
//   PIN_BLOCK=latest node feedback-repro-04.mjs   the current head

import { gunzipSync } from "node:zlib";
import { createPublicClient, decodeEventLog, encodeFunctionData, http, pad, parseAbi, toEventSelector } from "viem";

// ---------------------------------------------------------------- network and (public) addresses
const RPC = "https://api.hideki2.infra.testnet.somnia.network"; // Somnia Tokyo testnet (Hideki), chain 50383
const CHAIN = { id: 50383, name: "Somnia Hideki testnet", nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
const INDEXER = "https://hideki-dev.smk.somnia.host/v1/graphql";
const POOL = "0xd6cb1dd58580b84d76068ac21594219ce03aeddf"; // ETH/USDso perp pool
const BANK = "0x478769E1177C0773c43A593DCCc4Ad15F15F1394"; // MarginBank (holds every account's position)
const SAFE = "0x9b29D1086BCa079CC07b859B406b84E5b8c9e7B1"; // our account, which holds a live 0.004 ETH long in this pool
const OPEN_TX = "0x0d6392c3636aede9f7e36ea64bb42986f53bb8c6968d015b952f24dceea4b47c"; // the tx that opened that position
const OPEN_BLOCK = 28608011n;
const SDK_TARBALL = "https://registry.npmjs.org/@somnia-chain/markets-sdk/-/markets-sdk-0.32.1.tgz";
const RECORDED_BLOCK = 28619406n;
const SAMPLE = 10; // per group

const ABI = parseAbi([
  "function getPosition(address account, address perpPool) view returns ((int128 size, uint128 avgEntryPrice, int256 entryFundingIndex, uint64 lastUpdatedTimestampNs))",
  "function getLastFundingUpdateTimestampNs() view returns (uint64)",
]);
const POSITION_UPDATED = parseAbi(["event PositionUpdated(address indexed account, address indexed perpPool, int128 newSize, uint128 avgEntryPrice, int256 realizedPnl, int256 entryFundingIndex)"]);

const client = createPublicClient({ chain: CHAIN, transport: http(RPC) });
const line = (s = "") => console.log(s);
const short = (a) => `${a.slice(0, 8)}...${a.slice(-4)}`;
const hex = (n) => `0x${n.toString(16)}`;
const age = (secs0) => { const s = Math.max(0, secs0), d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60); return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m ${s % 60}s`; };

const PIN = process.env.PIN_BLOCK === "latest" ? await client.getBlockNumber() : BigInt(process.env.PIN_BLOCK ?? RECORDED_BLOCK);
const pinned = { blockNumber: PIN };
const pinBlock = await client.getBlock({ blockNumber: PIN });
const NOW = Number(pinBlock.timestamp);
const readPos = (account) => client.readContract({ address: BANK, abi: ABI, functionName: "getPosition", args: [account, POOL], ...pinned });

line("feedback-repro-04: MarginBank.getPosition().lastUpdatedTimestampNs is always 0");
line("=".repeat(96));
line(`Pinned block: ${PIN}${process.env.PIN_BLOCK ? (process.env.PIN_BLOCK === "latest" ? " (head, via PIN_BLOCK=latest)" : " (set via PIN_BLOCK)") : " (the recorded block; default)"}   chain time ${new Date(NOW * 1000).toISOString()}   chain ${CHAIN.id}`);
line("Every chain read below is pinned to that block. No key, no signature, no transaction.");

// ================================================================== 1. our Safe
line("\n1. Our Safe's position (an account that is known to have been updated, and to have lived through a funding settlement)");
const mine = await readPos(SAFE);
line(`   getPosition(Safe, pool) = size ${mine.size} | avgEntryPrice ${mine.avgEntryPrice} | entryFundingIndex ${mine.entryFundingIndex}`);
line(`   >>> lastUpdatedTimestampNs = ${mine.lastUpdatedTimestampNs}`);
const lastFundingNs = await client.readContract({ address: POOL, abi: ABI, functionName: "getLastFundingUpdateTimestampNs", ...pinned });
const openBlk = await client.getBlock({ blockNumber: OPEN_BLOCK });
line(`   the position was opened in tx ${OPEN_TX} at block ${OPEN_BLOCK} (${new Date(Number(openBlk.timestamp) * 1000).toISOString()});`);
line(`   the pool's last funding settlement at this block was ${new Date(Number(lastFundingNs / 1_000_000_000n) * 1000).toISOString()}, which is ${lastFundingNs / 1_000_000_000n > openBlk.timestamp ? "AFTER" : "not after"} the open. The field is 0 either way.`);
const raw = (await client.call({ to: BANK, data: encodeFunctionData({ abi: ABI, functionName: "getPosition", args: [SAFE, POOL] }), ...pinned })).data;
const words = Array.from({ length: (raw.length - 2) / 64 }, (_, i) => `0x${raw.slice(2 + i * 64, 2 + (i + 1) * 64)}`);
line(`   raw return: ${words.length} words (${words.length * 32} bytes). If the 4-field ABI were wrong, extra or shifted words would appear:`);
const names = ["size (int128)", "avgEntryPrice (uint128)", "entryFundingIndex (int256)", "lastUpdatedTimestampNs (uint64)"];
words.forEach((w, i) => line(`      word ${i}: ${w}  ${names[i] ?? "UNEXPECTED extra word"}`));

// ================================================================== 2. other live positions (freshest and oldest)
line("\n2. Other live positions in the same pool, freshest and oldest, each confirmed live on chain at the pinned block");
// 2a. freshest: from the chain itself (PositionUpdated logs in windows of 1000 blocks, newest first), so it does not depend on the indexer
const topic0 = toEventSelector(POSITION_UPDATED[0]);
const seen = new Set([SAFE.toLowerCase()]);
const fresh = [];
for (let w = 0n; w < 12n && fresh.length < SAMPLE; w++) {
  const to = PIN - w * 1000n, from = to - 999n;
  const logs = await client.request({ method: "eth_getLogs", params: [{ address: BANK, fromBlock: hex(from), toBlock: hex(to), topics: [topic0, null, pad(POOL.toLowerCase(), { size: 32 })] }] });
  for (const l of logs.reverse()) {
    const d = decodeEventLog({ abi: POSITION_UPDATED, topics: l.topics, data: l.data });
    const acct = d.args.account;
    if (seen.has(acct.toLowerCase())) continue;
    seen.add(acct.toLowerCase());
    const p = await readPos(acct);
    if (p.size === 0n) continue;
    fresh.push({ account: acct, p, atBlock: BigInt(l.blockNumber) });
    if (fresh.length >= SAMPLE) break;
  }
}
for (const f of fresh) f.ts = Number((await client.getBlock({ blockNumber: f.atBlock })).timestamp);
// 2b. oldest: only the indexer can enumerate holders; take rows by updatedAt ASC and confirm each on chain
const oldest = [];
let indexerNote = "";
try {
  for (let offset = 0; offset < 3000 && oldest.length < SAMPLE; offset += 300) {
    const query = `{ PerpPosition(where: {pool: {_eq: "${POOL}"}}, order_by: {updatedAt: asc}, limit: 300, offset: ${offset}) { account size updatedAt updatedAtBlock } }`;
    const res = await (await fetch(INDEXER, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query }) })).json();
    if (res.errors) throw new Error(JSON.stringify(res.errors).slice(0, 120));
    const rows = res.data.PerpPosition;
    if (rows.length === 0) break;
    for (const r of rows) {
      if (oldest.length >= SAMPLE) break;
      if (r.size === "0" || Number(r.updatedAtBlock) > Number(PIN) || seen.has(r.account.toLowerCase())) continue;
      seen.add(r.account.toLowerCase());
      const p = await readPos(r.account);
      if (p.size === 0n) continue;
      oldest.push({ account: r.account, p, ts: Number(r.updatedAt), atBlock: BigInt(r.updatedAtBlock) });
    }
  }
} catch (e) { indexerNote = `(indexer unavailable: ${e.message}; the oldest group is skipped)`; }
const table = (title, rows, src) => {
  line(`\n   ${title} (${rows.length}); "last update" from ${src}`);
  line(`   ${"account".padEnd(16)} ${"on-chain size".padEnd(26)} ${"lastUpdatedTimestampNs".padEnd(23)} ${"last update (UTC)".padEnd(26)} ${"block".padEnd(10)} age`);
  for (const r of rows) line(`   ${short(r.account).padEnd(16)} ${String(r.p.size).padEnd(26)} ${String(r.p.lastUpdatedTimestampNs).padEnd(23)} ${new Date(r.ts * 1000).toISOString().padEnd(26)} ${String(r.atBlock).padEnd(10)} ${age(NOW - r.ts)}`);
};
table("FRESHEST live positions", fresh, "the latest PositionUpdated event on chain");
table("OLDEST live positions", oldest, "the indexer's updatedAt / updatedAtBlock");
if (indexerNote) line(`   ${indexerNote}`);

// ================================================================== 3. tally
line("\n3. Tally");
const all = [{ account: SAFE, p: mine, ts: Number(openBlk.timestamp), label: "ours" }, ...fresh, ...oldest];
const zero = all.filter((r) => r.p.lastUpdatedTimestampNs === 0n), nonzero = all.filter((r) => r.p.lastUpdatedTimestampNs !== 0n);
const ages = all.map((r) => NOW - r.ts);
line(`   live positions examined (ours + ${fresh.length} freshest + ${oldest.length} oldest): ${all.length} | lastUpdatedTimestampNs == 0: ${zero.length} | != 0: ${nonzero.length}`);
for (const r of nonzero) line(`   NON-ZERO ${short(r.account)}: raw ${r.p.lastUpdatedTimestampNs} -> ${new Date(Number(r.p.lastUpdatedTimestampNs / 1_000_000_000n) * 1000).toISOString()}`);
line(`   age since last update spans ${age(Math.min(...ages))} to ${age(Math.max(...ages))}${oldest.length ? `; oldest sampled updatedAtBlock ${oldest[0].atBlock} vs the pinned block ${PIN}` : ""}`);

// ================================================================== 4. storage view
line("\n4. Storage view: which bank storage slots does getPosition read, and what do they hold? (debug_traceCall, prestateTracer)");
const target = oldest[0] ?? fresh[fresh.length - 1] ?? { account: SAFE };
for (const [label, acct] of [["our Safe", SAFE], [`${oldest[0] ? "oldest" : "a"} sampled position ${short(target.account)}`, target.account], ...(fresh[0] ? [[`freshest sampled position ${short(fresh[0].account)} (updated ${age(NOW - fresh[0].ts)} before the block)`, fresh[0].account]] : [])]) {
  try {
    const t = await client.request({ method: "debug_traceCall", params: [{ to: BANK, data: encodeFunctionData({ abi: ABI, functionName: "getPosition", args: [acct, POOL] }) }, hex(PIN), { tracer: "prestateTracer", tracerConfig: { diffMode: false } }] });
    const st = Object.entries(t).find(([a]) => a.toLowerCase() === BANK.toLowerCase())?.[1]?.storage ?? {};
    const slots = Object.entries(st).filter(([k]) => k.toLowerCase() !== "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"); // drop the EIP-1967 implementation slot
    line(`   ${label}: ${slots.length} struct slot(s) read (proxy implementation slot excluded)`);
    slots.forEach(([k, v], i) => line(`      slot +${i}  ${k.slice(0, 14)}...  = ${v}  ${i === 0 ? "(size | avgEntryPrice, packed)" : i === 1 ? "(entryFundingIndex)" : i === 2 ? "(lastUpdatedTimestampNs)" : ""}`));
  } catch (e) { line(`   ${label}: debug_traceCall unavailable on this RPC (${(e.details ?? e.shortMessage ?? e.message).slice(0, 60)}); skipped. Section 1's raw return already shows word 3 = 0.`); break; }
}

// ================================================================== 5. ABI search in the SDK package
line("\n5. Is there any other position timestamp, in the shipped SDK? (in-memory scan of the public @somnia-chain/markets-sdk@0.32.1 tarball)");
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
let sdkCheck = null;
try {
  const res = await fetch(SDK_TARBALL);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const files = new Map();
  for (const { name, data } of tarFiles(gunzipSync(Buffer.from(await res.arrayBuffer())))) {
    if (/^package\/dist\/[A-Za-z]*[Aa]bi\.js$/.test(name) || name === "package/src/perp/state.ts") files.set(name, data.toString("utf8"));
  }
  const state = (files.get("package/src/perp/state.ts") ?? "").split("\n");
  const li = state.findIndex((l) => l.includes("lastUpdatedTimestampNs: bigint"));
  line(`   SDK documentation (package/src/perp/state.ts):`);
  if (li > 0) { line(`      line ${li}:   ${state[li - 1].trim()}`); line(`      line ${li + 1}:   ${state[li].trim()}`); }
  const fnHits = new Map(), evHits = [];
  for (const [name, text] of files) {
    if (!name.startsWith("package/dist/")) continue;
    for (const m of text.matchAll(/"(function (\w*[Pp]osition\w*)\([^"]*)"/g)) fnHits.set(`${name.split("/").pop()}: ${m[1]}`, /imestamp/i.test(m[1]));
    for (const m of text.matchAll(/name:\s*"(Position\w*)",\s*inputs:\s*\[([\s\S]*?)\],\s*anonymous/g)) {
      const fields = [...m[2].matchAll(/name:\s*"(\w+)"/g)].map((x) => x[1]);
      evHits.push(`${name.split("/").pop()}: event ${m[1]}(${fields.join(", ")})  ${fields.some((f) => /timestamp|updatedAt/i.test(f)) ? "<-- has a timestamp field" : "(no timestamp field)"}`);
    }
  }
  line(`   position-related FUNCTIONS in the shipped ABI modules (${fnHits.size}):`);
  for (const [k, ts] of fnHits) line(`      ${k}${ts ? "   <-- the only timestamp field" : ""}`);
  line(`   position-related EVENTS in the shipped ABI modules (${new Set(evHits).size}):`);
  for (const k of [...new Set(evHits)]) line(`      ${k}`);
  sdkCheck = { onlyOneGetter: fnHits.size === 1, tsCount: [...fnHits.values()].filter(Boolean).length, eventTs: evHits.some((e) => e.includes("<-- has a timestamp")) };
} catch (e) { line(`   (could not fetch or scan the SDK tarball: ${e.message}; skipped)`); }

// ================================================================== 6. verdict
line("\n6. Verdict");
line("=".repeat(96));
if (nonzero.length > 0) {
  line(`NOT uniform: ${nonzero.length} of ${all.length} live positions have a non-zero lastUpdatedTimestampNs, so the field IS written under some conditions and our 0 may be condition-specific. See the NON-ZERO rows in section 3.`);
} else {
  line(
    `lastUpdatedTimestampNs is 0 on ALL ${all.length} live positions examined at block ${PIN} (ours, ${fresh.length} freshest, ${oldest.length} oldest), spanning ${age(Math.min(...ages))} to ${age(Math.max(...ages))} since their last update.\n` +
      `The raw return has exactly ${words.length} words matching the 4-field ABI, and the struct's third storage slot reads zero, so this is not a decoding artifact: no write to the field is observed on any sampled position (inferred: the contract has no code path that sets it).\n` +
      `${sdkCheck ? `In the shipped SDK, getPosition is ${sdkCheck.onlyOneGetter ? "the only position getter" : "one of several position getters"}, this is ${sdkCheck.tsCount === 1 ? "its only timestamp field" : "not the only timestamp field"}, and ${sdkCheck.eventTs ? "some position event does carry a timestamp" : "no position event carries a timestamp"}.\n` : ""}` +
      `The SDK documents it as "Last position update (nanoseconds)", so a consumer relying on it silently receives 0. Not a security issue.\n` +
      `Limits: one pool (ETH-PERP), one block, one chain; "age" for the oldest group is the indexer's last-update time, not necessarily the position's creation or the contract version that wrote it; other pools were not checked.`,
  );
}
