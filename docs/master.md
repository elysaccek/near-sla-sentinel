# Oracle Master

The Master tracks operator approval and connectivity for registered nodes.
The V2 escrow uses the account roster agreed by the provider and customer.
Master approval grants access to the Master heartbeat endpoint. Each oracle
keeps its node identity key and NEAR signing key on its own host. The NEAR
account, hostname, region, and hardware reported during registration are
self-reported. Registration proves possession of the node identity key.
When an operator assigns a V2 agreement, the Master also verifies the node's
registered NEAR public key and agreement membership at the same finalized block.

## Run the service

For the packaged Linux Master with PostgreSQL and HTTPS, use the
[deployment runbook](deployment.md#master). This section starts the native
Node process directly.

Install Node 22.22.2 or later and provision a PostgreSQL database for the
registry. Give the service a dedicated database role that can create tables and
indexes there. Use verified TLS for a remote database. The Master applies its
migrations on startup in a transaction and checks the digests of applied files.

Run the following from `packages/master`. Set `SLA_MASTER_DATABASE_URL` through
your service manager or shell before starting.

```sh
npm ci
export SLA_MASTER_AUDIENCE='https://master.example.com'
export SLA_MASTER_ADMIN_FILE="$HOME/.config/sla-sentinel/master-admins.json"
export SLA_MASTER_ADMIN_TOKEN_FILE="$HOME/.config/sla-sentinel/operator-token"
umask 077
mkdir -p "$HOME/.config/sla-sentinel"
node --input-type=module -e '
  import { randomBytes } from "node:crypto";
  import { writeFileSync } from "node:fs";
  const token = randomBytes(32).toString("base64url");
  const files = { mode: 0o600, flag: "wx" };
  writeFileSync(process.env.SLA_MASTER_ADMIN_TOKEN_FILE, token + "\n", files);
  writeFileSync(process.env.SLA_MASTER_ADMIN_FILE, JSON.stringify({ operator: token }) + "\n", files);
'
npm start
```

Keep the private files outside the repository. Generate them once. The server
binds to `127.0.0.1:8789` by default. Set `SLA_MASTER_PORT` to change the port.
For a container on a private network, set `SLA_MASTER_HOST=0.0.0.0` and
keep the API port private. Sandbox keeps the loopback bind. Set
`SLA_MASTER_DATABASE_PASSWORD_FILE` to use a file with a password-free
PostgreSQL URL.
For a remote installation, terminate TLS in a reverse proxy on the same host
and restrict `/admin/` to the operator network. Use a stable, unique audience
per deployment and configure the same value on clients. The service limits
registration requests by the direct peer, so behind a proxy it shares a
30-requests-per-minute bucket among proxied clients. Add a per-client limit
at the proxy and exclude authorization headers and registration bodies from
request logging.

## Enable signed assignments

Generate a dedicated Ed25519 key on the Master. Distribute the public file to
workers through a trusted operator channel. The key signs assignments only.

```sh
export SLA_MASTER_ASSIGNMENT_KEY_FILE="$HOME/.config/sla-sentinel/assignment-private.der"
export SLA_MASTER_ASSIGNMENT_PUBLIC_FILE="$HOME/.config/sla-sentinel/assignment-public.der"
umask 077
node --input-type=module -e '
  import { generateKeyPairSync } from "node:crypto";
  import { writeFileSync } from "node:fs";
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const options = { mode: 0o600, flag: "wx" };
  writeFileSync(process.env.SLA_MASTER_ASSIGNMENT_KEY_FILE, privateKey.export({ type: "pkcs8", format: "der" }), options);
  writeFileSync(process.env.SLA_MASTER_ASSIGNMENT_PUBLIC_FILE, publicKey.export({ type: "spki", format: "der" }), options);
'
npm start
```

The Master defaults to FastNEAR Testnet RPC for agreement and access-key reads.
Set `SLA_MASTER_TESTNET_RPC_URL` to use a different trusted HTTPS Testnet RPC.

## Manage the registry

The authenticated `GET /admin/oracles/summary` endpoint returns registered,
online and pending counts across the whole registry. Online counts include
active nodes with a recent heartbeat. The
[local console](local-console.md) uses this endpoint alongside the paginated
node registry.

In a second terminal, set `SLA_MASTER_ADMIN_TOKEN_FILE` to the operator token
file. Set `SLA_MASTER_URL` for a remote HTTPS Master. The CLI defaults to
`http://127.0.0.1:8789`.

```sh
npm run admin -- invite --ttl 900
npm run admin -- pending
npm run admin -- approve "$SLA_NODE_ID"
npm run admin -- heartbeats "$SLA_NODE_ID"
```

The invitation command returns the code once. Deliver it through a private
channel. The Master stores its SHA-256 digest and consumes it in the same
transaction that saves a verified registration. `invitations` and `list` return
pages of up to 50 entries, and `--after` takes the returned `next` cursor.
Use `revoke-invite` for an unused invitation. Node actions are `approve`,
`reject`, `disable`, `enable`, and `revoke`. `node` shows approval and
connectivity separately. The Master displays an active node as offline after
90 seconds without a heartbeat. Administrative changes and enrollment events
are recorded in the PostgreSQL audit log.

Reject and revoke are terminal and preserve the node ID, identity public key,
and claimed NEAR account as reserved values. This controls reuse of known
identifiers. Establishing the identity of an operator using entirely new
identifiers requires operator review.

## Assign a finalized SLA

Create a V2 agreement with the chosen oracle account in its frozen roster. The
worker also needs a dedicated Function Call key scoped to the escrow's
`submit_vote` method. After approval, run the following from `packages/master`:

```sh
npm run admin -- assign "$SLA_NODE_ID" --contract "$SLA_CONTRACT" \
  --sla-id "$SLA_ID" --endpoint "$SLA_ENDPOINT"
npm run admin -- assignments "$SLA_NODE_ID"
```

The Master reads the contract code hash, terms and access-key permission at
one finalized block. It checks the endpoint hash and confirms the account is
in the roster. It stores a signed assignment for that node. Reissuing the
same assignment is idempotent. Master approvals, disables, and revocations
control future assignment delivery. To revoke the ability to submit an
existing on-chain vote, the oracle account operator must remove the scoped
NEAR key. The agreement roster stays fixed.

The database migration preserves pre-existing registry records. Those records
can still use the heartbeat API. Assignment issuance requires a registered
vote public key. The earlier protocol allowed registration without one.

## Worker protocol

1. Create and persist a UUIDv4 and an Ed25519 key pair on the worker. Send
   `POST /oracles/registration/challenge` with JSON fields `invite_code`,
   `node_id`, `identity_key`, `near_account`, `near_public_key`, and optional `metadata`.
   Encode the raw 32-byte public key as unpadded Base64url. The current
   registry accepts named `.testnet` accounts. The response supplies
   `id`, `expires_at`, and a UTF-8 `message` to sign.
2. Confirm the message array contains the registration domain
   `sla-sentinel/registration/v1`, the configured audience, the challenge
   UUID, and the submitted node ID, public key, NEAR account, metadata, and
   NEAR vote public key, in that order. Sign the exact message string. Send
   `POST /oracles/registration/verify` with `challenge_id` and the 64-byte
   `signature` encoded as unpadded Base64url. A successful registration
   returns `PENDING_APPROVAL`.
3. After approval, send `POST /oracles/heartbeat` about every 30 seconds.
   Set `X-SLA-Node` to the UUID and `X-SLA-Signature` to the unpadded Base64url
   Ed25519 signature. Sign the UTF-8 JSON array below, serialized without
   whitespace between elements. Use the SHA-256 hex digest of the exact JSON
   request body. Include a fresh UUIDv4 `request_id`, Unix milliseconds
   `reported_at_ms`, and a `health` object in the body.

```text
["sla-sentinel/heartbeat/v1","<audience>","POST","/oracles/heartbeat","<node-id>","<body-sha256>"]
```

The server accepts timestamps within 60 seconds of its clock and persists
request IDs to reject replays. Each node can submit at most one accepted
heartbeat per 10 seconds. Health fields are optional strings with up to
120 characters. The current fields include `version`, `uptime`, `cpu`, `ram`,
`active_slas`, `last_measurement`, `rpc`, `last_error`, `queue`, `control`,
`clock`, `diagnostic`, and `fault`.

For status and assignments, use signed `POST /oracles/registration/status`
and `POST /oracles/assignments`. Their domain is
`sla-sentinel/node-request/v1`, followed by the same audience, method, path,
node UUID and body digest fields. Each request uses a new UUID and timestamp.
Assignments use an optional `after` cursor. Each response item is signed with
domain `sla-sentinel/assignment/v1` and binds the audience, node UUID and
policy snapshot. See [Oracle worker](worker.md) for the operator workflow.

In a local Sandbox, admins can use `fault-set`, `fault-status`, and
`fault-clear` to manage signed demo schedules. Each change records an
audit entry and creates a new revision. See the [Sandbox fault workflow](worker.md#controlled-worker-faults).
The signed `POST /oracles/fault-schedule` endpoint returns the latest plan
for an active node in that local network.

## Verify the Master

The [integration workflow](../.github/workflows/checks.yml) runs the Master
tests against PostgreSQL on pushes and pull requests.

Run from `packages/master` with a disposable PostgreSQL test database:

```sh
npm ci
SLA_MASTER_TEST_DATABASE_URL="$SLA_TEST_POSTGRES_URL" npm test
```

The database role must be able to create and drop the random test schema.
The integration suite checks concurrent invitation use, signed registration,
approval, heartbeat replay and freshness, restart recovery, revocation,
duplicate registration, pagination, and request throttling. The migration
suite checks concurrent startup, preservation of existing records, and
rollback and retry after a failed migration. Without the database URL,
the migration and HTTP integration tests are skipped. The identity signature
and finalized RPC policy tests still run.
