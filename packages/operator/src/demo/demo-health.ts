import { createServer } from "node:http";
import { parseArgs } from "node:util";

function positiveInteger(value: string | undefined, option: string): number {
  if (!value || !/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error("Use positive integer milliseconds for " + option);
  }
  return Number(value);
}

const { values } = parseArgs({ options: {
  "start-ms": { type: "string" },
  "slot-ms": { type: "string", default: "3000" },
  "repeat-ms": { type: "string" },
} });
const startsAt = positiveInteger(values["start-ms"], "--start-ms");
const slotMs = positiveInteger(values["slot-ms"], "--slot-ms");
const repeatMs = values["repeat-ms"] === undefined ? undefined : positiveInteger(values["repeat-ms"], "--repeat-ms");
const downAt = startsAt + 2 * slotMs;
const recoveredAt = startsAt + 7 * slotMs;
if (slotMs < 1_000 || slotMs > 3_600_000 || !Number.isSafeInteger(recoveredAt)) {
  throw new Error("Use a valid agreement start and slot length");
}
if (repeatMs !== undefined && repeatMs < 8 * slotMs) {
  throw new Error("--repeat-ms must allow the demo outage and at least one recovery slot");
}

const server = createServer((request, response) => {
  response.setHeader("Cache-Control", "no-store");
  if (request.method !== "GET" || request.url !== "/health") {
    response.writeHead(404).end();
    return;
  }
  const elapsed = Date.now() - startsAt;
  const phase = repeatMs === undefined || elapsed < 0 ? elapsed : elapsed % repeatMs;
  const down = phase >= 2 * slotMs && phase < 7 * slotMs;
  response.writeHead(down ? 503 : 200, { "Content-Type": "text/plain; charset=utf-8" });
  response.end(down ? "Controlled demo outage\n" : "OK\n");
});
server.listen(8787, "127.0.0.1", () => {
  console.log(JSON.stringify({ endpoint: "http://127.0.0.1:8787/health", downAt, recoveredAt, repeatMs }));
});
