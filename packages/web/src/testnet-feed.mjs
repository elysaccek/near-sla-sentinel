import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isBase58Hash, isTestnetAccount, isU64 } from "../../shared/oracle-protocol.ts";
import { demoPairWindow, demoRoles, demoWindows, previousDemoPayout, testnetDemo } from "../../shared/testnet-demo.ts";

export const pilotHistory = [
  ["3 oracles · 2 required", "breach", "4FYix5pdH16pMshdLJRv5dqfBSbvt2cwrzTPMEk5wHYo", "F7hZ9vdDzmSJNV3ioULpCd55qy2wRCR58hzStvaq8sdE", "94h5YYYfH4YFwJF2drT2JiCbAsuETgt7sCQWERddLccc"],
  ["5 oracles · rotating quorum", "inconclusive", "2yz7xKe5iiHr6sczPSwLea2QMQk1Ami3eNLXX5Lbdu8K", "Bo47hF1Fhm5bXBkefajgANJpgV4GVjcXEoazfbLjtCHW", "9nE6SSvfKBCqCqAs3phbSxDjp9reqZ3mky1htii1nkXq"],
  ["7 oracles · 5 required", "breach", "DPPDMpYk1NXjFUQ8xafR8EWMg4kMfr3XDMBMzRtzUfro", "3a9d7vWsH9MPWG9T8PtWr821SfvnUBgoSSBhC68BXAUV", "7dLYUQwPo7dqep6fSNnAjW88EAbW6haiLmMSZU6XsUmf"],
].map(([label, outcome, tx, transfer, callback], i) => ({
  label, outcome, tx, transfer, callback, sla: String(i), amount: previousDemoPayout,
  contract: "v2-243355531f-escrow.sla-v2-c8d8fcf53ff5.testnet", source: "pilot",
}));

const scenarioIds = new Set(["oracle-a", "oracle-b", "oracle-pair", "target"]);
const outcomes = new Set(["breach", "healthy", "inconclusive", "unaccepted"]);
const phases = new Set(["waiting", "funding", "scheduled", "observing", "reporting", "settling", "funding-required", "retrying", "paused"]);
const epoch = n => Number.isSafeInteger(n) && n > 0 && n < 8.64e15;
const safeAmount = value => typeof value === "string" && /^(0|[1-9][0-9]{0,38})$/.test(value);

async function readJson(path, max) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    const { size } = stat;
    if (!stat.isFile() || size > max || size < 1) throw new Error("Invalid Testnet feed size");
    const bytes = Buffer.alloc(size + 1);
    const { bytesRead } = await file.read(bytes);
    return JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
  } finally { await file.close(); }
}

function receipts(row) {
  return row && scenarioIds.has(row.scenario) && outcomes.has(row.outcome) && isU64(row.sla)
    && isBase58Hash(row.tx) && isBase58Hash(row.transfer) && isBase58Hash(row.callback)
    && epoch(row.start) && epoch(row.settledAt) && [previousDemoPayout, testnetDemo.payout].includes(row.amount);
}

function summarize(value) {
  const slots = value?.slots;
  const valid = count => Number.isInteger(count) && count >= 0 && count <= slots;
  if (!Number.isInteger(slots) || slots < 2 || slots > 64 || !valid(value.required) || value.required < 2
      || !valid(value.confirmed) || !valid(value.possible) || value.confirmed > value.possible
      || !Array.isArray(value.oracles) || value.oracles.length !== demoRoles.length) return undefined;
  const oracles = [];
  for (const [index, id] of demoRoles.entries()) {
    const report = value.oracles[index];
    if (report?.id !== id || typeof report.submitted !== "boolean" || !valid(report.up) || !valid(report.down)
        || !valid(report.unknown) || report.up + report.down + report.unknown !== slots
        || (!report.submitted && report.unknown !== slots)) return undefined;
    oracles.push({ id, submitted: report.submitted, up: report.up, down: report.down, unknown: report.unknown });
  }
  return { slots, required: value.required, confirmed: value.confirmed, possible: value.possible, oracles };
}

export async function readTestnetFeed(path, now = Date.now()) {
  const windows = [...demoWindows(now), { id: "oracle-pair", ...demoPairWindow(now) }];
  const schedule = windows.map(({ id, end, active, next }) => ({ id, availableAt: active ? end : next, active }));
  const empty = { network: "testnet", phase: "offline", schedule, history: [], serverTime: now,
    policy: { payout: testnetDemo.payout, slotMs: testnetDemo.slotMs, slots: testnetDemo.slotCount, minDown: testnetDemo.minDown } };
  let data;
  try { data = await readJson(path, 524_288); }
  catch (error) { return { ...empty, phase: error.code === "ENOENT" ? "offline" : "unavailable" }; }
  if (data?.network !== "testnet" || data.genesis !== testnetDemo.genesis || !isTestnetAccount(data.contract)
      || !epoch(data.updatedAt) || !phases.has(data.phase) || !Array.isArray(data.history)) {
    return { ...empty, phase: "unavailable" };
  }
  const age = now - data.updatedAt;
  const phase = age < -30_000 || age > 95_000 ? "stale" : data.phase;
  const run = scenarioIds.has(data.run?.scenario) && epoch(data.run.start) && epoch(data.run.end)
    && data.run.end > data.run.start ? {
      scenario: data.run.scenario, start: data.run.start, end: data.run.end,
      ...(isU64(data.run.sla) ? { sla: data.run.sla } : {}),
    } : undefined;
  function proof(row) {
    return {
      scenario: row.scenario, outcome: row.outcome, sla: row.sla, tx: row.tx, transfer: row.transfer,
      callback: row.callback, start: row.start, settledAt: row.settledAt, amount: row.amount,
      observations: summarize(row.observations),
      contract: data.contract, source: row.commissioning === true ? "commissioning" : "scheduled",
    };
  }
  return {
    ...empty, phase, run, updatedAt: data.updatedAt, contract: data.contract,
    observers: Array.isArray(data.observers) ? data.observers.slice(0, demoRoles.length).flatMap(observer => {
      if (!demoRoles.includes(observer?.id)
          || !["online", "offline"].includes(observer.state)) return [];
      return [{ id: observer.id, state: observer.state }];
    }) : [],
    reserve: safeAmount(data.reserve) ? data.reserve : undefined,
    history: data.history.slice(0, 500).filter(receipts).map(proof),
  };
}
