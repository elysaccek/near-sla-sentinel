import { readFile } from "node:fs/promises";
import { pilotHistory, readTestnetFeed } from "./testnet-feed.mjs";

const assets = new Map();
for (const [path, name, type] of [
  ["/", "product.html", "text/html"], ["/how-it-works", "how-it-works.html", "text/html"],
  ["/testnet", "testnet.html", "text/html"], ["/product.css", "product.css", "text/css"],
  ["/how-it-works.js", "how-it-works.js", "text/javascript"], ["/testnet.js", "testnet.js", "text/javascript"],
  ["/sentinel-hero.webp", "sentinel-hero.webp", "image/webp"],
]) {
  assets.set(path, {
    contentType: type === "image/webp" ? type : type + "; charset=utf-8",
    body: await readFile(new URL("../public/" + name, import.meta.url)),
  });
}

export async function serveProduct(path, response, headers) {
  const asset = assets.get(path);
  if (asset) {
    response.writeHead(200, { ...headers, "Content-Type": asset.contentType });
    response.end(asset.body);
    return true;
  }
  let body;
  if (path === "/api/testnet/activity") {
    body = { live: await readTestnetFeed(process.env.SLA_TESTNET_FEED_FILE ?? "/live-public/activity.json"), pilot: pilotHistory };
  }
  if (!body) return false;
  response.writeHead(200, { ...headers, "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
  return true;
}
