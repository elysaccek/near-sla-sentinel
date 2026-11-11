# SLA Sentinel monitor

`monitor.ts` probes one operator-approved endpoint over a frozen agreement schedule.
Its caller supplies agreement metadata read from NEAR, the oracle account ID,
and the approved URL from local configuration. The caller owns transaction
submission and evidence retention.

- `hashEndpoint(url)` returns SHA-256 of the exact canonical HTTPS URL as 32 byte
  values. Supply this to `create_sla`. Use a preapproved public DNS name, default
  HTTPS port and path, with credentials, query parameters and fragments omitted.
- `collectEvidence(config, url)` waits for the measurement window to close and
  returns `{ evidence, contract_vote }`. Pass `contract_vote` to `submit_vote`.
  Each slot can produce a single GET with redirects disabled. A timely 200 is
  Up. A timely 5xx is Down. Other statuses, missing observations, transport
  errors, and observations at or beyond the deadline are Unknown. Each GET has
  the shorter of 2.5 seconds and the remaining slot time.
- `verifyEvidenceBundle(bundle, { config, contract_vote })` rebuilds the
  observations, masks and digest and compares them with independent metadata
  and the recorded oracle vote. Supplying a bundle alone checks internal
  consistency. The digest commits to reported observations. The observer still
  supplies their accuracy.
- `assessWindow(slotCount, minDownSlots, votes)` recomputes the decision and both
  outage-streak bounds. Pass three on-chain vote slots in oracle order, with
  `null` for an unsubmitted vote. Compare with the finalized contract view.
- The local demo exception uses `{ localDemo: true }` and the exact
  `http://127.0.0.1:8787/health` URL.

The evidence document uses domain `sla-sentinel/evidence/v1`. SHA-256 hashes its
UTF-8 JSON with keys sorted at every depth and no whitespace. Slot observations
are in ascending slot order. The `up_mask` and `down_mask` use unsigned decimal
strings and bit zero for slot zero. Unknown contributes to neither mask.

Run the deterministic checks with Node 22.18+.

```sh
cd packages/operator
npm ci
npm test
```
