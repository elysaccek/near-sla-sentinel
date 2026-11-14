// These names identify an isolated test fixture. Requests stay on its Docker loopback.
export const endpoint = "https://sentinel-test.testnet/health";
export const controlEndpoint = "https://sentinel-control.testnet/health";
export const masterUrl = "http://127.0.0.1:8789";
export const audience = "sla-sentinel/testnet-demo";
export const reportingGraceMs = 120_000;
