# SLA Sentinel MVP architecture

## Decision

One provider-funded native NEAR escrow per accepted observation window. An agreement compensates at most once. The same two authorized oracle accounts must corroborate a contiguous run of failed samples. This preserves a prepaid guarantee while bounding storage, limiting the funds exposed to colluding oracles, and removing disagreements about assigning outages to wall-clock incident buckets. A future renewal creates new terms and a new agreement ID. A service outage that spans successive agreements is evaluated under each agreement's terms.

The first use case is an API provider offering a capped service credit to an integration customer. The terms cover sampled behavior of a designated endpoint, including the sampling schedule and response criteria. The prototype relies on the endpoint representing the service the customer uses. Distinct accounts prove distinct signing identities. Operator, hosting, DNS, and network independence are deployment assumptions that the demo must disclose. Providers and customers should evaluate whether the promised credit justifies prefunding, gas, and operating costs.

## Contract

| Call | Authority and effect |
| --- | --- |
| `create_sla` | Provider attaches the exact compensation plus the published 0.02 NEAR storage deposit. Allocates one ID and freezes parties, three distinct oracles, endpoint digest, policy version, start, duration, failure threshold, and report deadline. |
| `accept_sla` | Named customer accepts before the start. The contract's block time controls the boundary. |
| `submit_vote` | Each authorized predecessor can submit one digest and two disjoint 64-bit masks after the end and before the report deadline. The least-significant bit is slot zero. A zero bit in both masks denotes an unknown. |
| `finalize` | Any account can finalize after the report deadline, or when all three votes are recorded. An unaccepted offer is finalizable at its start. The verdict fixes the claim beneficiary. |
| `claim` | The beneficiary starts a native NEAR transfer. The transaction must attach at least 60 Tgas. The contract reserves 30 Tgas for the callback. |
| `on_payment` | Private callback checks exactly one promise result and the current payment attempt. It marks success or restores the entitlement on explicit transfer failure. |
| `get_sla`, `storage_deposit`, `agreement_count` | Read-only views for the dashboard and auditor. |

The ID of the one payable window is its agreement ID within the network and contract. The voting slot is keyed by agreement ID and oracle position. Votes for separate agreements never combine. Finalization permanently authorizes one compensation to the customer on `breach`. For `healthy`, `inconclusive`, or `unaccepted`, it authorizes return of the escrow to the provider. Returning collateral on inconclusive results allocates measurement availability risk to the customer and gives the provider an incentive to favor missing evidence. The customer consents to that rule before the window starts. Separate oracle administration is important to that bargain.

The funded principal is one integer yoctoNEAR liability. In `unavailable` it is locked, in `claimable` it is owed to the frozen beneficiary, in `pending` it is committed to a single in-flight attempt, and in `paid` the contract has confirmed transfer success. No independent withdrawal can spend the same liability. Gas is paid by the callers. The fixed-size agreement includes space for every vote and settlement state at creation. The storage deposit remains with the contract to maintain the audit record. The creation receipt measures the agreement's storage increase and includes an allowance for root state. Keep a separate balance for deployed code and runtime account storage.

A callback that itself fails may leave the payment pending indefinitely. Inspect the original transaction and all receipts at `FINAL`. A wall-clock timeout cannot establish transfer failure, so this build has no timed retry or administrator override. The contract account's full-access key can replace the contract. Disclose the key configuration of each deployment. Removing that key on a dedicated demo deployment is an irreversible operator decision.

NEP-297 events use `standard: sla_sentinel`, `version: 1.0.0`, and `data[0].sla_id`. Event names are `agreement_funded`, `agreement_accepted`, `vote_recorded`, `agreement_finalized`, `payment_pending`, `payment_succeeded`, and `payment_failed`. Index only successful receipts. The signed transaction and receipt IDs come from RPC, while the contract view records the current state and attempt.

## Measurement and evidence

For window start `S`, slot length `D`, and `N` slots, slot `i` spans `[S+iD, S+(i+1)D)`. Agree a fixed HTTPS `GET` URL and hash its exact UTF-8 representation. Workers schedule one probe at the start of each slot and cap it at the earlier of 2.5 seconds or the slot end. The demo profile uses 3-second slots and five consecutive corroborated failed samples. Synchronize host clocks and suppress votes from hosts with unsynchronized time. Missed or late probes and local failures are unknown. A valid `200` is up and a valid `5xx` is down. Transport, DNS, TLS, and timeout failures are unknown in this profile because attribution is ambiguous. The product UI should explain which failure modes the guarantee covers.

For each of the three oracle pairs, intersect their down masks and measure the longest contiguous run. The maximum across pairs is the confirmed lower bound. For each pair, union their up masks and invert within the window. The maximum run across those masks is the possible upper bound. `breach` requires the lower bound to reach the threshold. `healthy` requires the upper bound to fall below it. The remaining outcome is `inconclusive`. A changing quorum across a long run cannot fabricate an agreement between two observers. This model can miss outages between samples, failures only one vantage point sees, and transport-level outages classified as unknown.

Each oracle commits to canonical JSON with SHA-256. Include the schema version, network, contract, agreement, oracle, endpoint digest, slot schedule and normalized observations. Persist and publish bytes before submitting the vote. The verifier fetches the on-chain masks and digest, rehashes the downloadable bytes, rebuilds the masks, and recomputes the outcome across verified reports. A missing bundle is displayed as unavailable. The digest commits to bytes and the transaction authenticates the reporter. HTTP measurements rely on the observers. Retain independent copies with the observer and demo publisher.

The operator configures exactly one allowlisted HTTPS URL for the demo target. Never take a destination from an API request or from agreement metadata. Disable redirects and restrict egress to the permitted target. Reject credentials, unsafe destination addresses, and unexpected DNS resolution for externally hosted probes. The dedicated loopback target is available only in explicit local demo mode. Serve response codes without ingesting arbitrary response bodies or credentials. Dedicated oracle accounts use method-scoped, zero-deposit `submit_vote` keys with bounded gas allowances. Retry the same vote after reading final chain state. Each worker keeps its own key. The API and frontend receive no signing keys.

## Backend and frontend

Use a small TypeScript read API and SQLite. Chain views are authoritative for verdict and payment. Cache finalized events under `(network, contract, receipt_id, event_index)` with the transaction hash, signer, block height, and event payload. Store evidence by `(network, contract, sla_id, oracle)` with a unique digest, the canonical bytes, and ingest time. Store samples under the same key plus slot index, or derive them from the bounded bundle. The reporter uploads evidence before recording a vote and reconciles by `(sla_id, oracle)` after RPC failures.

| Endpoint | Response |
| --- | --- |
| `GET /api/slas/:id` | Final contract view, explorer links, and each vote's evidence availability. |
| `GET /api/slas/:id/evidence/:oracle` | Original canonical bytes for verification and download. |
| `GET /api/slas/:id/events` | Successful finalized receipts and their ordered events. |

Build one English React screen with immutable terms, three rows of aligned samples, confirmed and possible streaks, and payment status. Show `Pending` until a successful transfer receipt and callback agree. When enabled, NEAR Connect signs acceptance and claim. The CLI path covers funding and signing with separate demo accounts. A local-only toggle changes the dedicated demo service's health code. The signed Testnet votes, escrow, transfer, and receipts are real test-network actions when run against Testnet.

The Rust contract is in `contracts/sla-escrow`. The operator package separates CLI commands, monitoring, oracle signing, settlement verification, and demo support under `packages/operator/src`. Its tests live in `packages/operator/test`. The recorded Testnet evidence lives in `examples/testnet`. The read API and React screen are planned extensions. Use Testnet RPC and separate deployment, provider, customer, and oracle accounts for the public demo. Confirm `FINAL` execution, inspect the customer transfer and contract callback receipts, then link the transaction in a Testnet explorer. A transaction being included is insufficient for the paid status.

## Demo acceptance

1. Confirm the exact Testnet funding amount and the customer's accepted, frozen terms. The Testnet runner uses eight 3-second slots, a threshold of five, and 0.1 test NEAR in compensation.
2. Serve 200 during the first two slots and deliberately serve 503 in slots 2–6, then restore 200. Start each worker against the same target before the window. Have two authorized accounts submit signed votes from actual measurements. A third vote permits immediate finalization. With two votes, wait for the reporting grace to end.
3. Rebuild both evidence digests and the five-slot shared streak. Use the contract view to show the finalized customer entitlement. Record the customer claim's transaction hash and signer.
4. Query `tx` with `wait_until: FINAL`, and use `tx_status` on an RPC provider that supports it to inspect the receipt actions. Check the native transfer deposit equals the agreement amount, the transfer receiver matches the customer, the transfer and callback succeeded, and `get_sla` reports `paid`. The customer balance change is net of the caller's gas.
5. Repeat the claim and reject it. Show a separate inconclusive window or evidence replay where different pairs cover different pieces of an outage and no pair reaches the threshold. Include both sample gaps and the deployment's actual oracle topology in the recording.

Also run unauthorized and repeated votes, callback forgery, wrong beneficiary, out-of-window reports, invalid masks, missed observations, early closeout, refund, and native transfer failure. A callback failure is a separate case from a failed transfer. Use final receipts to identify which occurred before documenting any recovery.

