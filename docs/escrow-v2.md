# SLA Sentinel escrow V2

V2 is a separate contract at `contracts/sla-escrow-v2`. Deploy and initialize
it on a new account for each independent Testnet pilot. V1 agreements settle
on their original account. New windows can use V2 after both parties review
the terms. Agreement identity is the network, contract account, and SLA ID.

## Agreement and voting

The provider calls `create_sla` with the customer, ordered oracle accounts,
endpoint hash, schedule, failure streak threshold, reporting grace, and
compensation. V2 also accepts an optional `down_quorum`. The contract supports
3–16 distinct oracle accounts per agreement and 2–64 slots. The default quorum
is a strict majority. The provider can select a higher quorum up to unanimity.

The roster and quorum are frozen at creation. The named customer accepts
before the window starts. Each listed account can send one zero-deposit
`submit_vote` with a pair of disjoint masks and an evidence digest. Bit zero
denotes the first slot. Reporting begins at the end of the window and ends
at the reporting deadline. The contract recognizes account membership. It
relies on the parties to choose independently operated oracles.

Anyone can call `finalize` after the deadline or when all oracles have voted.
The same quorum must support every slot of a candidate run. Confirmed support
requires Down throughout the run. Possible support requires no Up in the run.
Unsubmitted votes are Unknown. A confirmed run at or above the threshold
yields `breach`. A possible run below the threshold yields `healthy`. The
remaining outcome is `inconclusive`. An unaccepted offer can be finalized at
or after its start time.

## Storage and settlement

Call `storage_deposit({ "oracle_count": N })` for the storage quote. The
provider attaches exactly that quote plus the compensation in yoctoNEAR.
The quote budgets 512 fixed bytes plus 120 bytes per oracle at the pinned
NEAR SDK's byte price. Creation measures the records written and rejects any
agreement that exceeds its quote. All vote slots are allocated at creation.
The storage charge, including its margin, stays with the contract to retain
the audit record. The deployer funds the contract code and account storage.

On a breach, the customer can claim the compensation. On a healthy,
inconclusive, or unaccepted result, the provider can claim back the principal.
The beneficiary calls `claim` with zero deposit and at least 60 Tgas. Claim
records a single pending attempt before scheduling the transfer. The private
callback checks the pending attempt and transfer result before recording
`paid` or restoring `claimable` after an explicit transfer failure.
The callback reads a separate settlement record whose size is independent of
the oracle count. A callback failure can leave an attempt pending. Use the
[payment reconciliation runbook](operations.md#reconcile-a-v2-payment-attempt)
to inspect the original receipts at `FINAL`.

`get_sla` returns the terms, vote array, and settlement in one view. It includes
`policy_version: 2` and `down_quorum`. The event envelope keeps its version 1.0.0
schema. The [Testnet receipt verifier](operations.md#verify-a-recorded-testnet-settlement)
supports V2 compensation and refunds with `--policy-version 2`. Existing
compensation commands default to V1.

## Run the Sandbox checks

Build with Rust 1.95 and the `wasm32-unknown-unknown` target. From the repository
root, build the deployment artifact and the separate Sandbox fixture:

```sh
RUSTFLAGS='--cfg near' cargo build --locked --release \
  --manifest-path contracts/sla-escrow-v2/Cargo.toml --target wasm32-unknown-unknown
RUSTFLAGS='--cfg near' cargo build --locked --release --features sandbox-fixture \
  --manifest-path contracts/sla-escrow-v2/Cargo.toml --target wasm32-unknown-unknown \
  --target-dir contracts/sla-escrow-v2/target/fixture
```

Start a disposable local NEAR Sandbox as described in
[Oracle operations](operations.md#check-payment-in-a-local-sandbox).
From `packages/operator` after `npm ci`, run:

```sh
npm run test:sandbox:v2 -- --rpc http://127.0.0.1:34831 \
  --sandbox-home "$SLA_SANDBOX_HOME" \
  --wasm ../../contracts/sla-escrow-v2/target/wasm32-unknown-unknown/release/sla_escrow_v2.wasm \
  --missing-recipient-wasm ../../contracts/sla-escrow-v2/target/fixture/wasm32-unknown-unknown/release/sla_escrow_v2.wasm
```

The runner reports gas burnt by the named execution receipts, storage growth,
and the transfer and callback receipt IDs. It uses scripted vote masks to
exercise settlement on a real local chain. The Sandbox fixture exercises a
missing beneficiary and a gas-starved callback after a successful native
transfer. Use the default features to build the deployment artifact. The
runner checks the export lists before deploying either Wasm.

### Measured Sandbox results

The Rust 1.95.0 Linux ARM64 build used the default release profile, including
LTO, and was tested on Sandbox 2.14.0. A second clean build in the same
environment produced identical production and fixture Wasm bytes. Account
IDs were 64 bytes long in the measured cases. Gas figures are Tgas burnt by
the individual contract receipts, rounded to two decimal places.

| Oracles / quorum | Slots | Outcome | Stored bytes | Storage quote (NEAR) | Create | Max vote | Finalize | Callback |
| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 3 / 2 | 5 | Breach | 682 | 0.00872 | 1.81 | 1.75 | 1.69 | 1.56 |
| 5 / 3 | 4 | Inconclusive | 916 | 0.01112 | 1.85 | 1.79 | 1.71 | 1.56 |
| 7 / 5 | 8 | Breach after deadline | 1,150 | 0.01352 | 1.88 | 1.82 | 1.72 | 1.56 |
| 16 / 9 | 64 | Healthy | 2,203 | 0.02432 | 2.00 | 1.98 | 2.10 | 1.56 |

Two simultaneous claims signed with separate access keys produced one
verified transfer. The runner also verified an unaccepted-offer refund and
an explicit transfer failure followed by a single successful retry. A
separate fixture agreement proved that a successful transfer with a failed
callback keeps attempt 1 pending and blocks the beneficiary's next claim.
These are local Sandbox results for the tested scenarios.

### Build the reviewed Docker artifact

Set `SLA_V2_WASM` to a new writable file path outside the checkout. From the
repository root, use the pinned build stage:

```sh
docker build --target escrow-wasm -t sla-sentinel-escrow-build -f deployment/Dockerfile .
docker run --rm --entrypoint cat sla-sentinel-escrow-build \
  /build/contracts/sla-escrow-v2/target/wasm32-unknown-unknown/release/sla_escrow_v2.wasm \
  > "$SLA_V2_WASM"
sha256sum "$SLA_V2_WASM"
```

On macOS, use `shasum -a 256 "$SLA_V2_WASM"` for the last step.

The clean Linux ARM64 Docker build used for the Testnet pilots produced
160,093 bytes with SHA-256
`db80cd866ac62d18a15070ce0974dc299e4d2b04065d6ac276e713dc90e27e74`.
The finalized Testnet code hash is `FmrCakSHFE5fFPE6JyutaUCDRFgS99Py8pEyBFtoniLT`.
A native Cargo build can embed different source paths. Use the Docker stage
and verify the digest when reproducing the reviewed artifact.

## Run the V2 settlement pilot

The pilot uses a separate V2 escrow, disposable accounts and three accepted
agreements. Each oracle submits its report using an individual key scoped to
`submit_vote` on that escrow. The command checks the finalized code hash
against the local Wasm, recomputes the verdict from the bundles and verifies
the native transfer and its dependent callback at `FINAL`.

| Oracles / quorum | Controlled observations | Expected settlement |
| --- | --- | --- |
| 3 / 2 | All three see the same five consecutive HTTP 503 responses. | The customer claims 0.1 NEAR. |
| 5 / 3 | A, B and C see 503 in the first two slots. C, D and E see 503 in the last two. The other responses are HTTP 429, which are classified as Unknown. | Confirmed streak 2, possible streak 4. The provider recovers 0.1 NEAR. |
| 7 / 5 | Five see the same five consecutive HTTP 503 responses. Two see HTTP 429 during the outage. | The customer claims 0.1 NEAR. |

The target and all observations run on one host using the fixed loopback port
8787. The target returns scenario-specific responses by observer. The separate
[worker scenarios](worker.md#verify-locally) exercise Master interruption and
worker restart. Use the [deployment profiles](deployment.md) for operation
across hosts.

### Rehearse in Sandbox

Start the disposable local chain used for the contract checks above. From
`packages/operator` after `npm ci`, run:

```sh
npm --silent run test:pilot:v2 -- --rpc http://127.0.0.1:34831 \
  --sandbox-home "$SLA_SANDBOX_HOME" \
  --wasm ../../contracts/sla-escrow-v2/target/wasm32-unknown-unknown/release/sla_escrow_v2.wasm
```

The script exits successfully after checking all three scenarios, including
the wrong-beneficiary and duplicate-claim rejections. Its JSON records the
observations, vote hashes, finalized agreement and receipts.

### Run on Testnet

Use a new disposable sponsor with at least 5 spendable Testnet NEAR. The
runner allocates 4.55 Testnet NEAR across ten subaccounts and leaves a margin
for transaction fees. The sponsor authorizes account creation with a local
owner-only file containing its ED25519 key. The generated subaccount keys are
held in memory and are discarded at exit. Use a separate account and reviewed
key custody for a long-lived deployment.

Use the [NEAR CLI faucet flow](https://docs.near.org/tools/cli#account) to
create a sponsor. Generate and store its key locally, then provide its public
key to the faucet. Wait for the new account to appear in a finalized RPC view.
The [Testnet faucet](https://docs.near.org/getting-started/faucet) can add test
funds to an existing account if needed.

From `packages/operator`, point `SLA_V2_WASM` to the default-feature artifact
and set `SLA_V2_WASM_SHA256` to the SHA-256 of the reviewed build. Run the
read-only preflight first:

```sh
npm run demo:testnet:v2 -- --sponsor "$SLA_V2_SPONSOR" \
  --wasm "$SLA_V2_WASM" --wasm-sha256 "$SLA_V2_WASM_SHA256"
```

To deploy and execute the pilot, pass the path to the private sponsor key file
and write the proof outside the repository:

```sh
npm --silent run demo:testnet:v2 -- --sponsor "$SLA_V2_SPONSOR" \
  --wasm "$SLA_V2_WASM" --wasm-sha256 "$SLA_V2_WASM_SHA256" \
  --sponsor-key-file "$SLA_V2_SPONSOR_KEY_FILE" --submit > "$SLA_V2_PROOF_PATH"
```

Stderr reports the contract account and public transaction hashes as the run
progresses. Keep those lines if a network error interrupts verification. Once
a claim hash is printed, inspect it with the
[read-only verifier](operations.md#verify-a-recorded-testnet-settlement).
A fresh pilot invocation creates a new set of funded accounts.

### Recheck the recorded Testnet pilot

The pilot ran on
[`v2-243355531f-escrow.sla-v2-c8d8fcf53ff5.testnet`](https://testnet.nearblocks.io/address/v2-243355531f-escrow.sla-v2-c8d8fcf53ff5.testnet).
Each transaction settled 0.1 Testnet NEAR.

| SLA | Oracles / quorum | Confirmed / possible streak | Final settlement |
| --- | --- | --- | --- |
| 0 | 3 / 2 | 5 / 5 | [Customer compensation](https://testnet.nearblocks.io/txns/4FYix5pdH16pMshdLJRv5dqfBSbvt2cwrzTPMEk5wHYo) |
| 1 | 5 / 3 | 2 / 4 | [Provider refund](https://testnet.nearblocks.io/txns/2yz7xKe5iiHr6sczPSwLea2QMQk1Ami3eNLXX5Lbdu8K) |
| 2 | 7 / 5 | 5 / 5 | [Customer compensation](https://testnet.nearblocks.io/txns/DPPDMpYk1NXjFUQ8xafR8EWMg4kMfr3XDMBMzRtzUfro) |

Recheck the refund without credentials from `packages/operator` after `npm ci`:

```sh
npm run verify:payment -- --contract v2-243355531f-escrow.sla-v2-c8d8fcf53ff5.testnet \
  --provider v2-243355531f-provider.sla-v2-c8d8fcf53ff5.testnet --sla-id 1 \
  --tx 2yz7xKe5iiHr6sczPSwLea2QMQk1Ami3eNLXX5Lbdu8K --policy-version 2 --kind refund
```

For compensation, use `--customer v2-243355531f-customer.sla-v2-c8d8fcf53ff5.testnet`,
`--kind compensation` and the corresponding agreement ID and transaction above.
