# Oracle CLI and controlled outage

Use Node 22.22.2 or later.

```sh
cd packages/operator
npm ci
npm test
```

## Run the Testnet payment demo

The demo needs a disposable named `.testnet` sponsor with at least 6 spendable
Testnet NEAR and an ED25519 key that can create subaccounts. It allocates
5.25 Testnet NEAR to six disposable accounts, plus the sponsor's transaction
fees. Their keys exist in memory for this run. Keep the sponsor separate from
any production account. The controlled HTTP target and all three workers run
on the same machine. The votes and payment run on public Testnet.

From `packages/operator`, run the read-only preflight with your funded account:

```sh
npm run demo:testnet -- --sponsor "$SLA_TESTNET_SPONSOR"
```

To provision a new sponsor, use the NEAR CLI faucet command with a locally
generated public key. The example below stores only the disposable sponsor's
private key in a private temporary directory outside the repository. Run it
from `packages/operator` in your normal Terminal.

```sh
sla_sponsor_dir="$(mktemp -d)"
SLA_TESTNET_SPONSOR="sla-sentinel-$(date +%s).testnet"
sla_sponsor_public="$(node --input-type=module -e '
  import { writeFileSync } from "node:fs";
  import { KeyPair } from "near-api-js";
  const key = KeyPair.fromRandom("ed25519");
  writeFileSync(process.argv[1], key.toString(), { mode: 0o600, flag: "wx" });
  console.log(key.getPublicKey().toString());
' "$sla_sponsor_dir/sponsor")"
npx --yes near-cli-rs account create-account sponsor-by-faucet-service \
  "$SLA_TESTNET_SPONSOR" use-manually-provided-public-key "$sla_sponsor_public" \
  network-config testnet create
npm run demo:testnet -- --sponsor "$SLA_TESTNET_SPONSOR"
```

After preflight succeeds, load the sponsor key into your local shell. For a
sponsor provisioned above, run:

```sh
export SLA_TESTNET_SPONSOR_KEY="$(cat "$sla_sponsor_dir/sponsor")"
```

For an existing sponsor, set `SLA_TESTNET_SPONSOR_KEY` from your local
credentials instead. Run the demo and save the proof:

```sh
npm --silent run demo:testnet -- --sponsor "$SLA_TESTNET_SPONSOR" --submit > testnet-payment-proof.json
unset SLA_TESTNET_SPONSOR_KEY
```

The runner prints public account IDs and the claim explorer link to stderr. The
JSON contains the vote transaction hashes, measurement bundles, the final
agreement, and the raw claim receipts. If the runner stops after claiming,
use the printed transaction hash with the read-only receipt verifier below.

## Run a controlled local outage

Create an agreement with 10 slots, a threshold of five and a start time shared
with the health server. Allow enough time to accept the agreement and start the
workers before the window. The demo endpoint is
`http://127.0.0.1:8787/health`. Use the SHA-256 digest of that exact string for
the agreement. The service returns HTTP 503 in slots 2 through 6 and HTTP 200
before and after.

```sh
npm run demo:health -- --start-ms "$SLA_START_MS" --slot-ms 3000
```

In another terminal, create a directory for public evidence bundles and launch
one worker per oracle account before the window opens.

```sh
mkdir -p ./demo-evidence
npm run oracle -- --contract "$SLA_CONTRACT" --oracle "$SLA_ORACLE" \
  --sla-id "$SLA_ID" --endpoint http://127.0.0.1:8787/health \
  --local-demo --evidence-dir ./demo-evidence
```

The command reads the agreement from NEAR Testnet and saves the observation
bundle. Add `--submit` to send a zero-deposit `submit_vote` transaction. In
submission mode, supply the dedicated ED25519 function-call key through
`SLA_ORACLE_PRIVATE_KEY`. Its receiver must be the escrow, its only permitted
method must be `submit_vote`, and it needs a positive gas allowance. Keep
credentials outside the evidence directory.

Run the same command with the same evidence directory after a restart. Existing
evidence is verified and reused. After an ambiguous RPC response, inspect the
final chain vote before rerunning. A matching vote is reported as already
recorded. The command checks only oracle votes. The settlement proof comes from
the customer's transfer and callback receipts after a separate claim.

This loopback demo can run several signing identities on one host. For
independent hosted observations, configure each worker with the same approved
public HTTPS URL and apply an egress rule for that target.

## Verify a recorded Testnet compensation

After the customer calls `claim`, run the read-only verifier with the customer
account and claim transaction hash.

```sh
npm run verify:payment -- --contract "$SLA_CONTRACT" --customer "$SLA_CUSTOMER" \
  --sla-id "$SLA_ID" --tx "$SLA_CLAIM_TX"
```

The output identifies the transfer and callback receipt IDs and the exact
amount in yoctoNEAR. The verifier checks finality, the agreement state, the
native transfer, and the callback's promise dependency on that transfer.
Keep the JSON output with the demo. Show the rejected second claim separately.

## Check payment in a local Sandbox

This runner uses NEAR Sandbox 2.14 or later and a compiled `sla_escrow.wasm`.
Start a disposable chain and note the printed home directory:

```sh
sandbox_dir="$(mktemp -d)"
printf '%s\n' "$sandbox_dir"
near-sandbox --home "$sandbox_dir" init --fast --account-id test.near
near-sandbox --home "$sandbox_dir" run \
  --rpc-addr 127.0.0.1:34831 --network-addr 127.0.0.1:34832
```

From `packages/operator` in another terminal, run:

```sh
npm run demo:sandbox -- --rpc http://127.0.0.1:34831 \
  --sandbox-home "$SLA_SANDBOX_HOME" \
  --wasm ../../contracts/sla-escrow/target/wasm32-unknown-unknown/release/sla_escrow.wasm
```

Set `SLA_SANDBOX_HOME` to the printed directory. The runner creates isolated
test accounts and checks the payout and its callback with the same verifier
used in the Testnet demo. Its final JSON includes the payment receipt IDs and
whether a second claim was rejected. Stop the Sandbox node when finished.
Add `--measure` to use actual loopback HTTP probes from three workers. The
runner starts the controlled outage and includes the evidence bundles in its
JSON output. Each oracle vote uses a function-call key scoped to `submit_vote`.

To exercise the ambiguity rule, run the same Sandbox command with
`--scenario inconclusive` in place of `--measure`. Three scripted observation
bundles contain four slots. A and B report the first two slots down, and B and
C report the final two slots down. The agreement requires one pair to confirm
all four slots. The runner checks that the longest confirmed run is two, the
decision is `inconclusive`, the customer's claim fails, and the provider gets
the 0.1 NEAR principal back. The JSON includes the rejected customer transaction
and the provider refund and callback receipts.
