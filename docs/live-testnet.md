# Product site and live Testnet demo

For the Ubuntu release behind Cloudflare Tunnel, see the
[single-server runbook](single-server-testnet.md).

The public-facing product image serves the landing page, interactive policy
walkthrough, and Testnet feed. It has no wallet, database or signing-key
mounts. The Sandbox console is an explicit local opt-in documented in the
[operator guide](local-console.md). Product navigation links to the
walkthrough and Testnet history.

## Run the website

From the repository root:

```sh
docker compose -f deployment/testnet/compose.yml up --build -d --wait web
```

Open [http://127.0.0.1:8790](http://127.0.0.1:8790). Set `SLA_PRODUCT_PORT`
to change the loopback port. Put only this web service behind your HTTPS
reverse proxy if you want public access. The Sandbox console remains a
separate deployment. On the same host, the local profile can mount published
Testnet summaries read-only so its `/testnet` page shows the same activity.
Start the Testnet web service first, then apply the optional Compose file:

```sh
docker compose -f deployment/local/compose.yml -f deployment/local/with-testnet-feed.yml \
  up --build --no-deps -d --wait web
```

For a custom Testnet Compose project, set `SLA_TESTNET_ACTIVITY_VOLUME` to
that project's `live-public` volume name.

## Start the recurring demo

For a fresh Ubuntu deployment, use the
[one-command installer](single-server-testnet.md#install-from-github).
Use the manual steps below when supplying your own Testnet sponsor.

Create a new, dedicated Testnet sponsor. Save its ED25519 key locally in a
file owned by the container's UID 1000 with mode `0600`. Point
`SLA_DEMO_SPONSOR` to the sponsor account and `SLA_DEMO_SPONSOR_KEY` to the
absolute path of the key file by exporting both variables in the shell.
For Docker Desktop the mounted file must
have the same ownership as the provision service sees inside the VM.
To open and fund the sponsor, see the
[NEAR CLI account guide](https://docs.near.org/tools/cli#account) and
[Testnet faucet](https://docs.near.org/getting-started/faucet).

```sh
live_demo() {
  docker compose -f deployment/testnet/compose.yml "$@"
}
live_demo build provision
live_demo run --rm provision
live_demo run --rm -v "$SLA_DEMO_SPONSOR_KEY:/bootstrap/sponsor:ro" \
  provision node live/provision.mjs --submit
live_demo up --build -d --wait
```

The read-only command quotes the amount available and the amount required.
The default reserve is 1,000 Testnet NEAR in the **provider account**, with
4.3 NEAR in additional bootstrap funding and fee margin for a new setup.
Use `--provider-reserve 5` with the same command for a smaller trial. The
option funds a new provider account. To top up an existing provider,
transfer Testnet NEAR directly to the account shown by the read-only command.
Provisioning retrieves the reviewed Testnet Wasm and verifies its pinned
hashes before deploying it. For an offline artifact source use
`--wasm /container/path/to/artifact.wasm` with a read-only mount of the same
artifact. Chain access is still required to provision.
New demo agreements lock 0.01 NEAR plus the on-chain storage quote. A
confirmed breach pays the agreed 0.01 to the customer. Healthy or
inconclusive rounds return the principal to the provider. Earlier
agreements and pilot history retain their actual 0.1 NEAR amounts. Storage
and gas still cost Testnet NEAR.

The provisioning service is one-shot. Its sponsor and contract administration
keys are outside the runtime services. The runner has the dedicated provider
key because funding an agreement attaches NEAR. The customer and three voting
keys use narrow function-call permissions and separate finite gas allowances.
The provider reserve covers agreements. The oracle and customer access keys
also need enough allowance and account balance for continued reporting and
claims. Keep the provider account specific to this demo and its volumes private.
[NEAR access-key permissions](https://docs.near.org/protocol/accounts-contracts/access-keys)

## Schedule and proof

| Fixture | Cadence (UTC) | Controlled behavior |
| --- | --- | --- |
| Oracle A | Every 2 hours at minute 05 | The fixture returns HTTP 503 to A. |
| Oracle B | Every 3 hours at minute 05 | The fixture returns HTTP 503 to B. |
| A + B overlap | Every 6 hours at minute 05 | Both see HTTP 503. C sees HTTP 200. The runner creates one agreement for the combined window. |
| Target | Every 5 hours at minute 35 | All three can observe HTTP 503. |

Cadences use Unix epoch boundaries. The 2-, 3-, 5- and 6-hour frequencies
describe controlled fault windows. Each 503 window lasts three minutes.
The observation policy is fixed when an agreement is created. In this
demo each worker samples once every 10 seconds for the first six slots
of a scheduled window. The same two oracles must corroborate at least three
consecutive Down slots. C has no individual fault and sees a 503 only
during the shared target outage. The public history shows the finalized
counts for each oracle and identifies older pilot rows.

To run a one-time target outage at commissioning, set
`SLA_DEMO_COMMISSION=1` on `up` after provisioning. The runner waits for
enrolled online oracles and enough room before the next scheduled window.
It records that the commissioning run was allocated before activating the
fixture. A runner restart does not allocate it a second time.

The runner persists the signed transaction before submitting it and reuses
the same transaction on ambiguous responses. If a signed action cannot be
reconciled, the runner pauses before opening further agreements. The
operator can use the [settlement reconciliation steps](operations.md#reconcile-a-v2-payment-attempt).
After finality the runner checks the raw HTTP evidence hashes, transfer and
dependent callback. The local private runner volume retains full traces.
The browser receives the 500 most recent finalized summaries and links to
their Testnet explorer transactions.

The fixture target and control resolve inside this dedicated Docker
operation. The browser cannot modify their schedules. Master, signing
services and PostgreSQL publish no host ports. For independent real network
measurements, use the [separate oracle deployment profiles](deployment.md).
