import { createServer } from "node:http";
import { parseArgs } from "node:util";

function positiveInteger(value: string | undefined): number {
  if (!value || !/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error("Use positive integer milliseconds for --start-ms and --slot-ms");
  }
  return Number(value);
}

const { values } = parseArgs({ options: {
  "start-ms": { type: "string" },
  "slot-ms": { type: "string", default: "3000" },
} });
const startsAt = positiveInteger(values["start-ms"]);
const slotMs = positiveInteger(values["slot-ms"]);
const downAt = startsAt + 2 * slotMs;
const recoveredAt = startsAt + 7 * slotMs;
if (slotMs < 1_000 || slotMs > 3_600_000 || !Number.isSafeInteger(recoveredAt)) {
  throw new Error("Use a valid agreement start and slot length");
}

const server = createServer((request, response) => {
  response.setHeader("Cache-Control", "no-store");
  if (request.method !== "GET" || request.url !== "/health") {
    response.writeHead(404).end();
    return;
  }
  const now = Date.now();
  const down = now >= downAt && now < recoveredAt;
  response.writeHead(down ? 503 : 200, { "Content-Type": "text/plain; charset=utf-8" });
  response.end(down ? "Controlled demo outage\n" : "OK\n");
});
server.listen(8787, "127.0.0.1", () => {
  console.log(JSON.stringify({ endpoint: "http://127.0.0.1:8787/health", downAt, recoveredAt }));
});
