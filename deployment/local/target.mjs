import { createServer } from "node:http";
import { activeScenario } from "./demo-schedule.mjs";

const role = process.argv[2] ?? "target";
if (!["target", "control"].includes(role)) throw new Error("Expected target or control");
createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/ready") {
    response.writeHead(200).end();
    return;
  }
  if (request.method !== "GET" || request.url !== "/health") {
    response.writeHead(404).end();
    return;
  }
  try {
    const scenario = await activeScenario();
    if (role === "control" && scenario === "control-loss") {
      request.socket.destroy();
      return;
    }
    const status = role === "target" && scenario !== "healthy" ? 503 : 200;
    response.writeHead(status, { "Cache-Control": "no-store", "Content-Type": "text/plain" })
      .end(status === 200 ? "OK\n" : "Controlled demo outage\n");
  } catch {
    request.socket.destroy();
  }
}).listen(role === "target" ? 8787 : 8788, "127.0.0.1");
