# SLA Sentinel

SLA Sentinel lets API providers pre-fund outage compensation on NEAR. The provider deposits a fixed amount for an observation window, and the customer accepts the terms before monitoring starts. The same quorum of authorized oracles must corroborate the entire consecutive run of failed samples before the customer can claim. Verified deployments are available on NEAR Testnet.

## Explore the demo evidence

Open `docs/index.html` from a local checkout in your browser.
Compare oracle pairs in the Testnet payout and Sandbox refund, then open the
payment receipt details or the full evidence JSON. The viewer uses the archived
observations and needs no wallet or dependencies to open.

If the archived proofs change, regenerate the viewer data with Node 22.22.2 or
later by running `node docs/evidence-viewer/generate.mjs` from the repository root.

![SLA Sentinel concept illustration showing API monitoring and pre-funded compensation on NEAR](docs/assets/sla-sentinel-cover.jpg)

## How it works

![The original V1 flow uses three oracle accounts and a same-pair rule to settle an accepted agreement](docs/assets/sla-sentinel-flow.jpg)

Each oracle probes the endpoint and submits its own signed vote and evidence hash.

See the [architecture](docs/architecture.md) for agreement terms, evidence, and payment safety.

The [V2 escrow](docs/escrow-v2.md) supports per-agreement rosters and quorum.
The [V2 Testnet pilot](docs/escrow-v2.md#recheck-the-recorded-testnet-pilot)
verified two compensations and one refund with 3-, 5-, and 7-oracle policies.
The [Master registry](docs/master.md) manages oracle enrollment, operator approval,
and signed health reports separately from on-chain agreement membership.
[V2 oracle workers](docs/worker.md) verify and cache signed assignments, then
continue monitoring and reporting when the Master is unavailable. Workers
can check independent control endpoints and exercise local fault recovery in Sandbox.

## Run the local operations console

With Docker Compose available, start the Master, three oracle workers,
PostgreSQL, NEAR Sandbox and the V2 escrow on one host. From the repository
root, the interactive installer asks for the Compose project and web port:

```sh
node deployment/local/install.mjs
```

The default address is [http://127.0.0.1:8780](http://127.0.0.1:8780).
Open **How it works** for the animated funding, quorum and payment walkthrough.
The [local console guide](docs/local-console.md) explains how to opt in to
Sandbox management and also covers direct Compose
commands, remote access via SSH, agreement signing and slot evidence. The
[two outage scenarios](docs/local-console.md#compare-a-target-outage-with-lost-control-reachability)
show how the same HTTP 503 yields different settlements depending on control
reachability.

## Product site and live Testnet

The [live Testnet guide](docs/live-testnet.md) starts a separate read-only
website and an optional one-host runner for scheduled 2-hour, 3-hour and
5-hour HTTP scenarios. Agreements settle on NEAR Testnet and the history
links each verified transfer to its transaction.

For a one-command Ubuntu install from the repository and an optional
Cloudflare Tunnel, see the [single-server Testnet guide](docs/single-server-testnet.md).

## Original Testnet demonstration

On November 11, 2026, three oracle accounts submitted signed observations of a
controlled HTTP outage. Agreement `0` recorded five consecutive failed slots
and paid the customer **0.1 Testnet NEAR**. A repeated claim was rejected by the
demo runner. The payment and callback receipts were verified at `FINAL`, and
the three evidence bundles were matched to the final on-chain votes.

![Testnet result summary showing three matching observation rows, five failed sample slots, and a confirmed 0.1 NEAR payout](docs/assets/sla-sentinel-testnet-result.jpg)

- [Payment transaction](https://testnet.nearblocks.io/txns/CtqZaUPokXKGr4XCpSfwCngN4Y91Gd3PRvPXCcVfXoLN)
- [Testnet contract](https://testnet.nearblocks.io/address/404f32f6-escrow.sla-sentinel-1794396951.testnet)
- [Evidence, agreement and receipt JSON](examples/testnet/payment-proof.json)

The controlled endpoint and all three observers ran on one host. The Testnet
contract account had one full-access key at verification time.

Recheck the payment without credentials from `packages/operator` after `npm ci`:

```sh
npm run verify:payment -- --contract 404f32f6-escrow.sla-sentinel-1794396951.testnet \
  --customer 404f32f6-customer.sla-sentinel-1794396951.testnet \
  --sla-id 0 --tx CtqZaUPokXKGr4XCpSfwCngN4Y91Gd3PRvPXCcVfXoLN
```

## Inconclusive evidence demonstration

The same contract was tested in NEAR Sandbox with four scripted sample slots
and a threshold of four consecutive failures. A question mark denotes a missing
sample.

| Oracle | Slot 1 | Slot 2 | Slot 3 | Slot 4 |
| --- | --- | --- | --- | --- |
| A | Down | Down | ? | ? |
| B | Down | Down | Down | Down |
| C | ? | ? | Down | Down |

Two oracles reported `Down` in every slot. The longest run confirmed by a
single pair was two, while the longest possible run was four. The contract
returned `inconclusive`, rejected the customer's claim, and refunded the
**0.1 Sandbox NEAR** principal to the provider. A second refund claim was
rejected. See the [Sandbox evidence and receipts](examples/sandbox/inconclusive-proof.json)
and the [reproduction command](docs/operations.md#check-payment-in-a-local-sandbox).

## Repository layout

| Path | Purpose |
| --- | --- |
| `contracts/sla-escrow/` | Rust agreement, escrow and payment logic, with contract tests. |
| `packages/operator/src/` | CLI commands, monitoring, oracle signing, settlement verification and demo support. |
| `packages/operator/src/worker/` | V2 worker identity, local persistence, probe scheduler, and NEAR reporting. |
| `packages/operator/test/` | TypeScript tests for measurements, signing and receipt verification. |
| `packages/master/` | Oracle registry API, admin CLI, PostgreSQL migrations and integration tests. |
| `packages/web/` | Local operations console and finalized agreement viewer. |
| `packages/shared/` | Shared assignment, request signing, and finalized NEAR RPC formats. |
| `deployment/` | Linux Compose profiles for the Master and each Oracle. See the [deployment runbook](docs/deployment.md). |
| `examples/testnet/` | Evidence and receipts from the recorded Testnet payment. |
| `examples/sandbox/` | Scripted observations and receipts from the inconclusive case. |
| `docs/` | Architecture, operator instructions and the evidence format. |

## Escrow checks

Install Rust 1.95.0 with the `wasm32-unknown-unknown` target. The contract is under `contracts/sla-escrow`.

```sh
cd contracts/sla-escrow
cargo test --locked --lib
RUSTFLAGS='--cfg near' cargo build --locked --release --target wasm32-unknown-unknown
SLA_ESCROW_WASM=target/wasm32-unknown-unknown/release/sla_escrow.wasm \
  cargo test --locked --features sandbox-tests --test sandbox
```

The sandbox suite uses isolated accounts and virtual funds. The signed Testnet demonstration requires separate development accounts and a published deployment record.

If the contract Wasm is already built, the [Node Sandbox payment check](docs/operations.md#check-payment-in-a-local-sandbox) runs the payment and duplicate-claim assertions without compiling Rust test dependencies.

## Oracle and receipt checks

Install Node 22.22.2 or later, then run:

```sh
cd packages/operator
npm ci
npm test
```

See the [Testnet demo commands](docs/operations.md) for running the
controlled outage, submitting oracle votes, and verifying the claim receipts.
The [single-command Testnet demo](docs/operations.md#run-the-testnet-payment-demo)
produces an explorer link and a JSON proof with a funded Testnet sponsor.

## License

[MIT](LICENSE)
