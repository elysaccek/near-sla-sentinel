# V2 oracle worker

Run one worker state directory per oracle identity. Each worker has an Ed25519
node identity key for Master requests and a separate NEAR Function Call key
for voting. The worker stores its identity, signed assignments, observations,
and reporting progress on local disk. Deploy separate operators and networks
for independent outage observations.

## Enroll a worker

For a packaged Linux worker, see the [Oracle deployment](deployment.md#oracle).
The native CLI flow below uses the same identity and access-key checks.

Install Node 22.22.2 or later. From `packages/operator`, run `npm ci`. Keep the
worker state and credentials outside the checkout. Use a local filesystem and
a dedicated operating system account for the service.

On the oracle account, provision an Ed25519 Function Call access key for the
V2 escrow account with the sole method `submit_vote` and a positive bounded
gas allowance. Use the oracle account's management signer on a trusted host
to add the public key. Store the matching `ed25519:…` secret on the worker
as a private file. Each worker process uses one oracle account, one vote key,
and one locally pinned escrow contract.

```sh
export SLA_WORKER_STATE="$HOME/.local/state/sla-sentinel/oracle"
export SLA_WORKER_VOTE_KEY_FILE="$HOME/.config/sla-sentinel/oracle-vote-key"
npm run worker -- join --master "$SLA_MASTER_URL" --oracle "$SLA_ORACLE" \
  --state-dir "$SLA_WORKER_STATE" --invite-file "$SLA_INVITE_FILE" --region "EU West"
```

Create the invitation with the [Master CLI](master.md#manage-the-registry).
Place the invitation and voting secret in files readable only by the
worker owner, using mode `0600`. The command prints the public node ID and
`PENDING_APPROVAL`. On retry, it reuses the same identity and checks whether
the Master already committed registration. Use `--audience` if the Master
audience differs from its public HTTPS origin.

Approve the node and [assign an SLA](master.md#assign-a-finalized-sla) from
the Master. Allow time for the worker to fetch the assignment and verify the
customer's acceptance before the first measurement slot. Use a reporting
grace period that accounts for finality, RPC failures and queued agreements.

## Run and inspect

```sh
npm run worker -- run --state-dir "$SLA_WORKER_STATE" \
  --assignment-pub "$SLA_MASTER_ASSIGNMENT_PUBLIC_FILE" \
  --contract "$SLA_CONTRACT" --code-hash "$SLA_CONTRACT_CODE_HASH" \
  --endpoint "$SLA_ENDPOINT"
```

Use the assignment public key exported by the Master in SPKI DER form. Pin
the expected contract code hash from the trusted deployment record, then
check it against the finalized NEAR account query. The worker accepts repeat
`--endpoint` flags for its local allowlist. Use the exact canonical HTTPS
URL hashed in the agreement. Configure outbound access for the approved
targets and RPC. The worker checks DNS results on the actual socket lookup,
uses TLS hostname verification, and leaves redirects un-followed.

Set `SLA_WORKER_TESTNET_RPC_URL` to use a trusted Testnet HTTPS RPC. The worker
reads the escrow policy and access-key permissions at one finalized block
and checks them again before sending a vote. The configured RPC remains a
trust dependency. Keep the host clock synchronized. The scheduler limits
simultaneous target probes to 16 and uses one pending transaction per key.

```sh
npm run worker -- status --state-dir "$SLA_WORKER_STATE"
npm run worker -- evidence --state-dir "$SLA_WORKER_STATE" \
  --contract "$SLA_CONTRACT" --sla-id "$SLA_ID"
```

The status command reports the most recent locally observed registration
state, measurement time, recent diagnostics, and task outcomes. A task's
`authorized` flag records a completed check of the accepted agreement, frozen
roster, and scoped NEAR vote key. The worker begins checking assignments
within 60 seconds of the window start. The evidence command prints the
canonical bundle when ready. Treat the local directory as durable data.
A second scheduler using that directory is rejected. To restart, use the
same state directory, identity, trusted public key, and escrow pins.

If the Master is unreachable, previously cached assignments still run and
can submit independently. An interrupted slot is recorded as unknown, and
already written measurements are reused. Transport errors and late results
produce unknown slots. The worker persists its evidence and signed
transaction before sending. On an ambiguous response, it checks the final
agreement vote and pending transaction before retrying the same bytes. It
requires a matching finalized vote to mark the task recorded. A finalized
transaction failure is retained in the task status.

### Connectivity diagnostics

Use repeatable `--control-endpoint` flags to specify one or two locally
approved HTTPS endpoints on distinct hostnames. Pick control services with
different hosting and network dependencies from the SLA target. The worker
checks them every ten seconds with a 1.5-second request deadline. Any HTTP
response confirms transport to that control host. A configured worker
requires a recent reachable control before it counts a timely target 5xx
as `DOWN`. A timely target 200 remains `UP`. With no controls configured,
the original 200/5xx policy applies.

DNS, TCP, TLS, timeouts, control unavailability and clock jumps appear in
the local diagnostic history. A combined target transport error and
failed controls is marked as suspected local trouble. These signals cannot
attribute a path failure to a specific ISP or host. RPC availability and
the local clock are reported in heartbeat independently. Control failures
cannot produce a `DOWN` vote on their own. The [canonical worker evidence](evidence.md)
commits to the raw response status and the local control state. A suppressed
response stays `UNKNOWN` in the vote masks.

The local Docker worker enables `--evidence-export-dir` to write the canonical
bundle to a separate owner-only volume after the matching vote is finalized.
The export is addressed by its vote hash. An export failure is retried
independently of monitoring and reporting. On startup the worker replays
recorded bundles in bounded batches. This also restores the export of older
bundles without changing their evidence hashes or sending a transaction.

Master disable or revoke stops new assignments. Removing the worker's
scoped NEAR access key is the on-chain revocation step for existing
assignments. The frozen roster stays in the agreement history.

## Verify locally

Run `npm test` from `packages/operator` for the worker and existing operator
tests. From `packages/master`, run `npm test` with
`SLA_MASTER_TEST_DATABASE_URL` set to a disposable PostgreSQL database to
exercise enrollment and signed assignment delivery.

Build the V2 escrow and start an isolated [NEAR Sandbox](escrow-v2.md#run-the-sandbox-checks).
Use a fresh chain for these wall-clock scenarios. The separate escrow suite
advances chain time for deadline tests.
After installing dependencies for both packages, run this from
`packages/master`:

```sh
for count in 3 5; do
  SLA_MASTER_TEST_DATABASE_URL="$SLA_TEST_POSTGRES_URL" npm run test:sandbox -- \
    --rpc http://127.0.0.1:34831 --sandbox-home "$SLA_SANDBOX_HOME" \
    --wasm ../../contracts/sla-escrow-v2/target/wasm32-unknown-unknown/release/sla_escrow_v2.wasm \
    --oracles "$count" || exit 1
done
```

The runner creates separate node identities, state directories, and oracle
accounts on one host. It enrolls and assigns all workers, stops the Master,
then restarts the first worker after it has persisted one real HTTP
measurement. Every worker must submit matching evidence to the local chain
and the agreement must finalize as a breach. The customer then claims the
0.1 NEAR compensation. The runner verifies the native transfer and private
callback at finality and checks that a second claim is rejected. It uses port
8787 for a controlled loopback HTTP 503 endpoint and reports local receipt IDs.

In NEAR Sandbox 2.14.0 on Linux ARM64, with a PostgreSQL 18.7 server behind
the Master, the 3-oracle scenario submitted three finalized votes from 9
probes and the 5-oracle scenario submitted five finalized votes from 15
probes. Both agreements finalized as `breach` using the default release
Wasm. The [Testnet recovery procedure](deployment.md#verify-reporting-during-a-testnet-master-outage)
also passed with three separate worker containers on one host. It used a
healthy HTTPS target and verified that signed Testnet votes finalized before
the Master recovered. Multi-host observations remain a separate check.

## Controlled worker faults

Fault plans are available in local Sandbox mode. A plan is signed by the
Master for a specific node and network, then cached on disk. Set
`SLA_MASTER_SANDBOX_NETWORK` and `SLA_WORKER_SANDBOX_NETWORK` to the local
Sandbox chain ID. Set `SLA_MASTER_SANDBOX_RPC_URL` and
`SLA_WORKER_SANDBOX_RPC_URL` to the loopback RPC URL. Start the Master with
its assignment key and use the loopback Master URL for the oracle. Pass
`--demo-faults` to the worker's `run` command to opt in.

For example, save the following shape in a JSON file, replacing the
timestamps with UTC epoch milliseconds. This schedule repeats every
three hours until expiry.

```json
{
  "fault_type": "target_connectivity",
  "starts_at_ms": 1800000000000,
  "interval_seconds": 10800,
  "duration_seconds": 30,
  "expires_at_ms": 1800086400000,
  "reason": "Simulated local connectivity loss"
}
```

From `packages/master`, set or clear the plan:

```sh
npm run admin -- fault-set "$SLA_NODE_ID" --schedule-file "$SLA_FAULT_FILE"
npm run admin -- fault-status "$SLA_NODE_ID"
npm run admin -- fault-clear "$SLA_NODE_ID"
```

Each occurrence may last up to 120 seconds. Each plan expires within seven
days of its start. The worker skips only target HTTP measurements and
records the affected slots as `UNKNOWN` with a local `CONTROLLED_FAULT`
diagnostic. The worker logs the start and end, caps the active window
with a monotonic timer and resumes probing automatically. Plans leave
SSH, host networking, Master communication, and NEAR RPC operational.
An offline worker keeps its last signed plan until its expiry or until
it receives a newer signed plan. An operator can stop the simulation
locally by starting the worker without `--demo-faults`.

For a target outage that repeats every 12 hours, run the loopback demo
endpoint from `packages/operator`:

```sh
npm run demo:health -- --start-ms "$SLA_START_MS" --slot-ms 3000 --repeat-ms 43200000
```

Use `interval_seconds` of 32400 for a nine-hour oracle fault and 10800
for a three-hour fault. Choose the participating nodes when assigning
their plans. A node without a plan continues to probe normally.

Add `--faults` to the Sandbox runner to test a node-specific fault
while the Master is offline. The selected worker restarts with its cached
plan, skips one target measurement, then resumes reporting HTTP 503 for
the controlled target outage. The other workers continue their measurements
and satisfy the agreement quorum.

In the Linux Sandbox runs with PostgreSQL 18.7, 3/2 and 5/3 agreements
finalized as `breach`.
The three-worker run made 8 real HTTP probes and the five-worker run made
14. Each run had one simulated `UNKNOWN` slot, followed by a real 503
measurement from the recovering worker.

Add `--drop-vote-response` to the Sandbox runner to test an ambiguous
submission. A loopback relay forwards one worker's vote to the chain and
waits until the vote has finalized, then closes the connection before
returning the response. The worker must recover the same transaction hash
by reading the finalized vote without broadcasting that vote again.
The five-worker Linux run verified one broadcast and the same finalized
transaction hash.
