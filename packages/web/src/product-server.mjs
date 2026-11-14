import { createServer } from "node:http";
import { serveProduct } from "./product.mjs";

const security = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

createServer({ requestTimeout: 10_000, headersTimeout: 5_000 }, async (request, response) => {
  try {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (request.method === "GET") {
      if (path === "/healthz") {
        response.writeHead(200, security).end("ok\n");
        return;
      }
      if (await serveProduct(path, response, security)) return;
    }
    response.writeHead(404, security).end("Not found\n");
  } catch {
    if (!response.headersSent) response.writeHead(503, security);
    response.end("Service unavailable\n");
  }
}).listen(8790, "0.0.0.0");
