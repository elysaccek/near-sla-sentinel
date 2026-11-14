import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { demoRoles, demoTargetStatus } from "../../shared/testnet-demo.ts";

const observerTokens = new Map(await Promise.all(demoRoles.map(async role => {
  const value = (await readFile("/observers/" + role + "/observer-token", "utf8")).trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) throw new Error("Invalid observer credential");
  return [role, Buffer.from(value)];
})));

async function commissioningOutage(now) {
  try {
    const { start, end } = JSON.parse(await readFile("/live-public/commissioning.json", "utf8"));
    return Number.isSafeInteger(start) && Number.isSafeInteger(end)
      && end > start && end - start <= 180_000 && now >= start && now < end;
  } catch (error) {
    if (error.code !== "ENOENT") console.error("Could not read the commissioning window");
    return false;
  }
}

createServer({ requestTimeout: 5000, headersTimeout: 3000 }, async (request, response) => {
  if (request.method !== "GET") return response.writeHead(405).end();
  if (request.url === "/ready") return response.writeHead(200).end();
  if (request.url !== "/health") return response.writeHead(404).end();
  const role = request.headers["x-sla-observer"];
  const token = typeof request.headers.authorization === "string" && request.headers.authorization.startsWith("Bearer ")
    ? Buffer.from(request.headers.authorization.slice(7)) : undefined;
  const expected = observerTokens.get(role);
  const observer = token && expected && token.length === expected.length && timingSafeEqual(token, expected) ? role : undefined;
  const now = Date.now();
  const status = await commissioningOutage(now) ? 503 : demoTargetStatus(now, observer);
  response.writeHead(status, { "Cache-Control": "no-store", "Content-Type": "text/plain" })
    .end(status === 200 ? "OK\n" : "Scheduled demo outage\n");
}).listen(8787, "127.0.0.1");
