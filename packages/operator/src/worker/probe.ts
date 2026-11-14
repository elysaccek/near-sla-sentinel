import { lookup } from "node:dns";
import { request } from "node:https";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";
import { TransportDiagnostic } from "./diagnostics.ts";

function publicAddress(address: string): boolean {
  if (isIP(address) === 0 || address.includes("%")) return false;
  const ip = ipaddr.parse(address);
  if (ip.kind() === "ipv4") return ip.range() === "unicast";
  return ip.range() === "unicast" && ip.match(ipaddr.IPv6.parse("2000::"), 3);
}

export const fetchPublicStatus: typeof fetch = async (input, options) => {
  const url = new URL(String(input));
  if (url.protocol !== "https:" || url.username || url.password || isIP(url.hostname) || url.hostname.startsWith("[")) {
    throw new Error("Expected a public HTTPS hostname");
  }
  // The DNS checks run on the address list the socket will actually use.
  return new Promise((resolve, reject) => {
    const req = request(url, {
      method: "GET", agent: false, headers: { "Cache-Control": "no-cache" }, signal: options?.signal ?? undefined,
      lookup(hostname, lookupOptions, callback) {
        lookup(hostname, { all: true }, (error, addresses) => {
          if (error) return lookupOptions.all ? callback(error, []) : callback(error, "", 0);
          if (addresses.length === 0 || addresses.some(({ address }) => !publicAddress(address))) {
            const error = new TransportDiagnostic("DNS_FAILURE");
            return lookupOptions.all ? callback(error, []) : callback(error, "", 0);
          }
          const candidates = addresses.filter(({ family }) => !lookupOptions.family || family === lookupOptions.family);
          if (lookupOptions.all && candidates.length) return callback(null, candidates);
          if (!candidates.length) {
            const error = new TransportDiagnostic("DNS_FAILURE");
            return lookupOptions.all ? callback(error, []) : callback(error, "", 0);
          }
          const { address, family } = candidates[0];
          callback(null, address, family);
        });
      },
    }, (res) => {
      const status = res.statusCode ?? 0;
      res.destroy();
      if (status >= 200 && status <= 599) resolve(new Response(null, { status }));
      else reject(new Error("Invalid HTTP status"));
    });
    req.on("error", reject);
    req.end();
  });
};
