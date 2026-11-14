# Linux deployment

The Master profile runs Caddy, Master and PostgreSQL. The Oracle profile runs one worker with its own local files. Both build from the source checkout with Docker Compose and use NEAR Testnet. The [Sandbox runbook](worker.md#verify-locally) covers disposable chain tests.

Use a Linux host with Docker Engine and Compose, a synchronized clock, and a local filesystem for service data. Point the Master DNS name to the host and allow inbound TCP 80 and 443 for Caddy certificate issuance and renewal. Each oracle needs outbound HTTPS to the Master, Testnet RPC, and its approved targets.

For local browser development, use the [one-command Sandbox and console profile](local-console.md).

## Run the demo on one server

Use the [interactive Sandbox installer](local-console.md)
to start the web console, Master, PostgreSQL, Sandbox and three oracle workers
on one Docker host. Select an unused web port and use
[SSH forwarding](local-console.md#choose-a-host-port) from your workstation.
The console uses virtual Sandbox NEAR and its own registry.

The separate Master and Oracle profiles below also work on one host for
Testnet operation. Use a distinct Compose project, state directory and scoped
voting key per oracle. Oracle workers connect outbound and publish no host
ports. The Testnet Master publishes only the Caddy HTTP and HTTPS listeners.
For example, a Sandbox console can use `18780` on loopback while the Testnet
Master uses `8080` for HTTP and `8443` for HTTPS.

## Interactive setup

Install Node 22.22.2 or later and run the installer for the host's role as a non-root user with Docker access. Run it from the repository root.

```sh
node deployment/master/install.mjs
node deployment/oracle/install.mjs
```

The Master asks for its DNS name, Testnet RPC, bind address and ports. It uses the bundled PostgreSQL service and generates the database passwords, operator token and signing keys. The Oracle asks for its Master origin, account, escrow and code hash, probe URLs, and paths to the private invitation and scoped vote key files and the trusted assignment public key.

For a Master listening on a custom HTTPS port, enter the full origin such as
`https://master.example.com:8443` in the Oracle installer. Keep the signed
Master audience `https://master.example.com` for the Compose Master, using
the Oracle installer's default. The HTTP listener redirects to the configured
HTTPS port. For automatic public certificate issuance, ensure the public ACME
challenge traffic reaches Caddy on the standard ports. An upstream edge can
forward those ports to the configured bindings. [Caddy ACME challenges](https://caddyserver.com/docs/automatic-https#acme-challenges)

Each command accepts an optional configuration directory outside the checkout. Defaults are `~/.config/sla-sentinel/master` and `~/.config/sla-sentinel/oracle`, or the corresponding paths under `XDG_CONFIG_HOME`. Use distinct directories and Compose project names for several workers on one host. Rerun with the same directory to reuse credentials, database volumes and identity. If enrollment failed before the invite was accepted, provide a fresh invite file at the retry prompt. Leave that prompt empty after enrollment. An operator still needs to approve a pending worker.

The installer saves its settings as `compose-settings`. Set `settings_file=compose-settings` and use the project name chosen during setup in the service commands below. Use `SLA_COMPOSE_OVERRIDE_FILE` to supply a local Compose override, for example to mount a private CA certificate with `NODE_EXTRA_CA_CERTS` in a private network. Keep certificate verification enabled.

## Master

For manual setup, prepare a private configuration directory from the repository root.

```sh
umask 077
master_dir="$HOME/.config/sla-sentinel/master"
mkdir -p "$master_dir/credentials"
chmod 700 "$master_dir" "$master_dir/credentials"
cp -n deployment/master/settings.env.example "$master_dir/settings.env"
```

Edit `settings.env` to set `SLA_MASTER_DOMAIN` to the public DNS name, `SLA_MASTER_CREDENTIALS` to the absolute credentials path, and `SLA_UID` and `SLA_GID` to the values from `id -u` and `id -g`. The domain value is a hostname without a scheme, port or path. The default proxy publishes IPv4 TCP ports 80 and 443. Use `SLA_BIND_IP` to select a specific IPv4 address. Keep the public origin stable after enrollment.

Generate credentials once with Node. The command uses mode `0600` and refuses to overwrite existing files.

```sh
node --input-type=module - "$master_dir/credentials" <<'JS'
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
const token = randomBytes(32).toString("base64url");
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const files = {
  "postgres-password": randomBytes(32).toString("base64url") + "\n",
  "database-password": randomBytes(32).toString("base64url") + "\n",
  "operator-token": token + "\n",
  "admins.json": JSON.stringify({ operator: token }) + "\n",
  "assignment-private.der": privateKey.export({ type: "pkcs8", format: "der" }),
  "assignment-public.der": publicKey.export({ type: "spki", format: "der" }),
};
if (Object.keys(files).some(name => existsSync(join(dir, name)))) {
  throw new Error("Credential files already exist. Reuse or restore the original set.");
}
for (const [name, contents] of Object.entries(files)) {
  writeFileSync(join(dir, name), contents, { mode: 0o600, flag: "wx" });
}
JS
```

Use a stable Compose project name to preserve the named volumes.

```sh
master() {
  docker compose -p sla-master -f deployment/master/compose.yml \
    --env-file "$master_dir/${settings_file:-settings.env}" "$@"
}
master up --build -d --wait
master ps --all
curl --fail --silent --show-error https://master.example.com/healthz
```

The database initializer creates a non-superuser application role and a schema it owns. On later starts it verifies the saved login and privileges. The Master reads its database password from a mounted file and applies migrations at startup. PostgreSQL and the raw Master API have no host port mapping. Caddy forwards the worker routes and `/healthz` over HTTPS. Run administration through the Master container.

```sh
master exec -T master node src/admin.ts invite --ttl 900
master exec -T master node src/admin.ts pending
master exec -T master node src/admin.ts approve "$SLA_NODE_ID"
master exec -T master node src/admin.ts assign "$SLA_NODE_ID" \
  --contract "$SLA_CONTRACT" --sla-id "$SLA_ID" --endpoint "$SLA_ENDPOINT"
```

Deliver the invitation `code` privately. Distribute `assignment-public.der` over a trusted channel. Caddy shares the Master’s 30-request-per-minute registration bucket across incoming clients. Enroll nodes in batches. Add per-client rate limiting at the edge when exposing enrollment to public traffic and omit registration bodies and authorization headers from logs.

## Oracle

Use a distinct Compose project, Testnet account, scoped vote key, credential directory and state directory per worker. The account operator provisions a key with a positive gas allowance and only `submit_vote` on the agreed V2 contract. Obtain the finalized code hash from the deployment record. See [worker enrollment](worker.md#enroll-a-worker).

For manual setup, create the worker directories and settings file.

```sh
umask 077
oracle_dir="$HOME/.config/sla-sentinel/oracle-eu-01"
mkdir -p "$oracle_dir/credentials" "$oracle_dir/state"
chmod 700 "$oracle_dir" "$oracle_dir/credentials" "$oracle_dir/state"
cp -n deployment/oracle/settings.env.example "$oracle_dir/settings.env"
```

Set both absolute directory paths, UID/GID, escrow account, code hash and target in the settings file. The two optional control URLs must use distinct HTTPS hostnames. Copy the scoped key to `credentials/vote-key` with mode `0600`. Copy the trusted `assignment-public.der` to `credentials/`. Save the one-use invitation in `credentials/invite` with mode `0600`.

```sh
oracle() {
  docker compose -p sla-oracle-eu-01 -f deployment/oracle/compose.yml \
    --env-file "$oracle_dir/${settings_file:-settings.env}" "$@"
}
oracle build
oracle run --rm --no-deps -v "$oracle_dir/credentials/invite:/run/sla-sentinel/invite:ro" \
  oracle join --master https://master.example.com --oracle "$SLA_ORACLE_ACCOUNT" \
  --invite-file /run/sla-sentinel/invite --region "EU West"
```

Keep the printed node UUID for approval. Once `PENDING_APPROVAL` or `ACTIVE` is returned, remove the local invitation file. The worker can start while approval is pending.

```sh
oracle up -d --wait
oracle exec -T oracle /bin/sh ./worker.sh status
oracle exec -T oracle /bin/sh ./worker.sh evidence \
  --contract "$SLA_CONTRACT" --sla-id "$SLA_ID"
```

The container health check checks for the local identity and SQLite files. Use `node NODE_ID` and `heartbeats NODE_ID` in the Master CLI to check connectivity. Previously cached, authorized assignments continue during a Master outage.

## Verify reporting during a Testnet Master outage

Use a disposable V2 agreement, separate oracle accounts, and an approved HTTPS
target. Use a short, stable healthy window to test reporting availability.
Use an endpoint operated for the test when exercising an outage. Keep the
Master, target, control endpoints and RPC reachable before the exercise. List
the hosts, network paths and shared dependencies in the test record.

1. Fund and accept an agreement with enough time for the workers to synchronize.
   Assign it to each active worker while the Master is healthy.
2. Run `oracle exec -T oracle /bin/sh ./worker.sh status` on each worker.
   Find the task named `testnet:<contract>:<sla-id>` and wait for
   `phase: "scheduled"` and `authorized: true`. The worker begins authorization
   checks within 60 seconds of the start. Save the task and node IDs.
3. On the Master host, stop only the disposable Master with
   `master stop master`. Check that the Master container is stopped and the
   HTTPS proxy returns 502 on `/healthz`. Record the time. Leave PostgreSQL,
   the workers, RPC and probe endpoints running.
4. Once `last_measurement_ms` shows a measurement in this window, restart
   one worker with `oracle restart oracle`. Keep its original state directory
   and scoped key. After the window, wait for `phase: "recorded"` on each
   worker. Collect the transaction hashes and the output of the `evidence`
   command above. Check that the Master is still offline. Compare the masks
   and evidence digests with the finalized agreement, and verify the vote
   transaction inclusion times fall inside the Master outage.
5. Restore the Master with `master start master` and check for fresh signed
   heartbeats from the same node IDs. Finalize the agreement and verify the
   claim at finality with the [receipt verifier](operations.md#verify-a-recorded-testnet-settlement).
   Exercise a duplicate claim on the disposable agreement and record the
   rejected transaction hash.

Three Docker containers on one host can exercise the worker and chain paths.
Use separate operator hosts and network paths to test independence.

### Recheck the recovery proof

Run this from `packages/operator` with Node 22.22.2 or later and the locked
dependencies installed. Point the argument to a recovery proof JSON file.

```sh
npm --silent run verify:worker-proof -- --proof "$SLA_WORKER_PROOF"
```

The verifier needs no wallet, Master or worker process. It queries Testnet
for the deployment, customer acceptance, each oracle's vote and scoped key
at inclusion, and the native transfer and callback at finality. It reads
agreement state at the callback block, rebuilds the evidence digests, and
recomputes the quorum verdict. It checks both inclusion and contract
execution against the recorded outage window and verifies the failed
duplicate claim. An inconsistent proof exits with an error.

The outage, worker restart and heartbeat times are operator observations.
The verifier checks the timeline against on-chain events and the worker
attestations. It has no independent view of the hosts or the Master process.

The JSON needs the following fields. Identifiers, times, digests and
transaction hashes come from the exercise.

| Fields | Source |
| --- | --- |
| `network`, `genesis`, `contract`, `code_hash`, `wasm_sha256`, `deployment_tx` | Testnet and the reviewed V2 deployment |
| `provider`, `customer`, `target`, `acceptance_tx`, `agreement`, `verdict` | Accepted URL, acceptance transaction and finalized agreement, plus quorum outcome with `confirmed` and `possible` slot counts |
| `oracles`, `evidence`, `vote_transactions` | Each oracle's `{account, public_key}`, canonical bundle from `worker evidence`, and `{oracle, hash, included_at_ms, up_slots}` |
| `settlement`, `duplicate_claim_rejected_tx` | JSON from the receipt verifier without `network`, and the rejected repeat claim hash. The original recovery proof uses `refund` in place of `settlement`. |
| `events`, `restarted_oracle` | Operator entries of shape `{event, ms}`, with UTC epoch milliseconds, and the restarted oracle's account |

Record `master_offline_confirmed` before the first slot. For the worker
you restart, record `oracle_first_probe_persisted` and `oracle_restarted`.
The original recovery proof uses `oracle_1_first_probe_persisted` and
`oracle_1_restarted` for the first account in the roster. Record
`all_votes_recorded_master_offline` after
all workers see their votes at finality while the Master is down. Record
`master_available_again` and `all_heartbeats_recovered` during recovery.
Use the vote's inclusion block timestamp in milliseconds for
`included_at_ms`. A [NEAR transaction status query](https://docs.near.org/api/rpc/transactions#transaction-status)
returns the block hash under `transaction_outcome`. Convert the
[block header timestamp](https://docs.near.org/api/rpc/block-chunk#block-details)
from nanoseconds. Count `result: "up"` observations in the evidence for
`up_slots`. Keep private keys, tokens and access details out of the proof.

## Verify independent oracle paths

Use three Linux oracle hosts with separate network egress and one Master
origin. Record which providers, regions, outbound routes, control hosts and
Testnet RPC endpoints the workers share. Record host and operator information
as reported by the operator unless independently verified. Start with the
reviewed V2 Wasm, a 2-of-3 policy, synchronized clocks and a healthy HTTPS
test target you operate. Configure the workers' independent control probes.

| Case | Conditions | Acceptance evidence |
| --- | --- | --- |
| Master unavailable | Cache the assignments, stop the Master before the window and restart one worker after its first persisted sample. Keep the target, controls and RPC available. | The three workers report during the Master outage and resume heartbeats after it returns. The agreement settles healthy and the provider refund verifies at finality. |
| Isolated probe failure | On one test host, interrupt access to the test target and its configured controls for the full window. Leave management access and Testnet RPC available. The other hosts continue to reach the healthy target. | The affected oracle's slots are Unknown and the other two report Up. The agreement settles healthy. The affected worker's target and controls recover in the next window. |
| Target outage | Serve the same HTTP 503 response from the test target for at least the configured consecutive slots. Keep controls reachable from a stable pair of workers for the same run. | The same two oracle accounts provide the entire confirmed streak. The agreement settles breach and the customer compensation and its callback verify at finality. |

Use separate funded agreements for the three cases. The [recovery verifier](#recheck-the-recovery-proof)
checks the first case, including the Master outage and restart timeline.
For the other cases, compare each worker's evidence hashes and masks with the
finalized votes and verify settlement with the
[receipt verifier](operations.md#verify-a-recorded-testnet-settlement).
Save the relevant transaction hashes, receipt IDs, probe and control results,
and the final contract state for each agreement.

## Restart and recovery

- Use `master restart master` or `oracle restart oracle`. Keep the same project names, credentials and state directories.
- Back up the Master credentials and registry dump in encrypted storage. From a private directory with `umask 077`, run `master exec -T database pg_dump -U postgres -d sentinel -n sentinel --no-owner --no-privileges -Fc > registry.dump`. Caddy retains certificates and keys in its named volume.
- Verify the dump in a fresh database. Temporarily grant its `sentinel` role `CREATE` on that database. Run `master exec -T database pg_restore -U postgres -d sentinel_restore_check --role=sentinel --exit-on-error --single-transaction --no-owner --no-privileges < registry.dump`, then revoke the temporary grant. Check the restored schema owner, migration records and registry counts.
- Stop an oracle before backing up the whole state directory and credentials. Restore ownership, state mode `0700` and private file mode `0600`. Run one copy of each identity and scoped key at a time.
- For a compromised node, run `master exec -T master node src/admin.ts revoke "$SLA_NODE_ID"`. Have the account operator remove its scoped NEAR voting access key and verify removal at finality. The accepted agreement roster stays fixed. See [assignment authorization](master.md#assign-a-finalized-sla).

See [Caddy automatic HTTPS](https://caddyserver.com/docs/automatic-https), [Docker Compose services](https://docs.docker.com/reference/compose-file/services/) and [PostgreSQL backup and restore](https://www.postgresql.org/docs/18/backup-dump.html).
