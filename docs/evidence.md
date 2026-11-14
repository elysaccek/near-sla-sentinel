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
- `assessQuorumWindow(slotCount, minDownSlots, downQuorum, votes)` evaluates an
  N/K policy. Supply one vote slot per authenticated member of the frozen roster.
  The same quorum must report Down throughout the confirmed run. A possible run
  requires the same quorum to have no Up vote anywhere in the run. An unsubmitted
  vote is Unknown in every slot. The evaluator requires at least three oracle
  slots and a strict majority quorum or higher.
- The local demo exception uses `{ localDemo: true }` and the exact
  `http://127.0.0.1:8787/health` URL.

The standalone collector and archived demonstrations use the
`sla-sentinel/evidence/v1` domain. Workers also produce
`sla-sentinel/evidence/v2`, which records `observed_http_status`,
`control_state` and `diagnostic` per slot. `http_status` is the value passed
to vote normalization. For example, a worker can record a 503 in
`observed_http_status` and leave `http_status` null when local control
reachability is unavailable. The slot remains Unknown and the timestamps
show when the request actually ran. Null control information means the
worker did not record a control state for that slot.

Both domains hash the evidence document with SHA-256 over UTF-8 JSON, with
keys sorted at every depth and no whitespace. Slot observations are in
ascending slot order. The `up_mask` and `down_mask` use unsigned decimal
strings and bit zero for slot zero. Unknown contributes to neither mask.
The V2 digest commits to the diagnostic fields as well as the observations.
The hash check establishes what the oracle attested. An external observer
still depends on the oracle to report its own network observations accurately.

Run the deterministic checks with Node 22.22.2 or later.

```sh
cd packages/operator
npm ci
npm test
```

The V2 escrow imports the standalone Rust N/K evaluator. Both
implementations run the shared cases in `fixtures/quorum-windows.tsv`. From
the repository root, run the Rust tests with:

```sh
cargo test --locked --manifest-path contracts/sla-quorum/Cargo.toml
```

See [Escrow V2](escrow-v2.md) for the on-chain policy and Sandbox checks.
