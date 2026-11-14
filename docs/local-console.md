# Local operations console

From the SLA Sentinel checkout with Node 22.22.2 or later and Docker Compose,
run the interactive installer:

```sh
export SLA_LOCAL_ENABLE_CONSOLE=1
node deployment/local/install.mjs
```

Choose a Compose project name and an available console port. The defaults
are `sla-sentinel-local` and `8780`. The installer prints the URL and saves
its settings outside the checkout in `~/.config/sla-sentinel/local` or under
`XDG_CONFIG_HOME`. Pass a separate absolute directory for a separate
installation. A rerun reuses the project and settings in that directory.
Edit the saved `SLA_LOCAL_PORT` in `compose-settings` and rerun that installer
to move the web console to another port. If Docker reports an occupied port,
use this same settings file to select a free port and rerun.

If this checkout already uses the direct Compose commands, keep that project
and its volumes with the same commands. From the checkout root:

```sh
export SLA_LOCAL_ENABLE_CONSOLE=1
docker compose -f deployment/local/compose.yml up --build -d --wait
```

Open [http://127.0.0.1:8780](http://127.0.0.1:8780). The first build downloads
NEAR Sandbox 2.14.0 and compiles the locked V2 Rust contract. The published
port serves the product pages and console on host IPv4 loopback. Compose starts a local
Sandbox chain, PostgreSQL, Master, three separately registered oracle
workers, and separate HTTP target and control services. It uses local
accounts and virtual NEAR.

Open [the local console](http://127.0.0.1:8780/console) directly after
starting the local profile with `SLA_LOCAL_ENABLE_CONSOLE=1`. The
default profile serves the read-only product pages and returns 404 for
console routes. The [Testnet product profile](live-testnet.md) is the public
deployment option. Keep the opt-in console on loopback for development.

## Choose a host port

You can also set the port directly with Compose. Use a different project
name and port for each stack that should run in parallel:

```sh
export SLA_LOCAL_ENABLE_CONSOLE=1
export SLA_LOCAL_PORT=18780
export COMPOSE_PROJECT_NAME=sla-sentinel-demo
docker compose -f deployment/local/compose.yml up --build -d --wait
```

Open [http://127.0.0.1:18780](http://127.0.0.1:18780). For the remaining
Compose examples use the same project and port for every invocation.
If you used the installer, pass the printed project with `-p` and the
printed settings path with `--env-file` for commands that manage the stack.
Changing the web port keeps the same Docker volumes and chain. Browsers
store wallets per origin, including the port. Before migrating a running
demo, finish its active wallet flows at the original address.

For a Linux server, forward the chosen port from your workstation:

```sh
ssh -N -L 18780:127.0.0.1:18780 operator@demo.example.com
```

Use the same browser and server port to match the console's origin check.
The browser opens the loopback URL through SSH. Each worker has its own
account, key, and state and shares the server's network path and uptime.

## Unlock management

Copy the disposable console operator token from your own terminal:

```sh
docker compose -f deployment/local/compose.yml exec -T web cat /run/console-auth/console-token
```

Paste it into the console's **Operator token** field and select **Unlock**.
The browser holds the token in memory until the console is locked or the tab
reloads. Keep the token and newly issued invitation codes private.

- **Oracle network** shows registry state, last heartbeat, latest diagnostic
  and assignment history. An active oracle is shown offline after 90 seconds
  without a heartbeat. Disabling or revoking an oracle changes its registry
  access. The escrow's accepted roster remains fixed, and the oracle account
  operator can separately revoke its NEAR access key.
- **Invitations** creates and revokes single-use enrollment codes. The code
  is displayed when issued. Approve or reject a pending node from its details.
- **Agreements** opens a local SLA by ID and refreshes its finalized state.
  It shows accepted terms, the current window, reported Up, Down and Unknown
  slots, and settlement status. A dash marks an unsubmitted report. Use
  **Slot evidence** to inspect the selected oracle's target response,
  finalized vote, control reachability and diagnostic for each slot.

## Create and accept an agreement

Use two separate browser profiles or browser contexts to represent the
provider and the customer. In each, open **Agreements**, select
**Connect Sandbox wallet** once the Sandbox is ready and use the displayed
funding command. Then select **Check balance**. The command transfers 2
virtual NEAR to the displayed public account. Use a current browser with
Ed25519 Web Crypto and Web Locks.
Run the displayed command from the checkout on the Docker host. It pins the
Compose project and Sandbox genesis for the active console.

In the provider's browser, unlock management, then return to **Agreements**.
Enter the customer's funded address, compensation, schedule, minimum outage
length and quorum, and select the oracle roster. The local profile uses its
configured demo target. Select **Review funding** to see the immutable terms,
the compensation, storage quote, attached deposit and gas limit. Select
**Sign transaction** to create the offer. After it finalizes, select
**Assign oracle roster** so the Master issues the worker assignments.

Use **Copy offer link** and open the link in the customer's browser on the
same machine. The link includes the Sandbox genesis so it stays tied to the
original chain. The customer can review the finalized terms and select **Accept offer** before
the observation window starts. Acceptance needs the customer wallet and
zero attached deposit. The operator token is used for registry and assignment
actions. It is unnecessary for viewing, accepting, finalizing or claiming
an agreement. Once reporting closes or all votes have arrived, a funded wallet
can finalize. The eligible beneficiary's wallet can then claim the payment
or refund. The console verifies the successful claim at finality and shows
the native transfer and callback receipt IDs.

The Sandbox key is generated as a non-exportable Ed25519 key and kept in that
browser's IndexedDB, scoped to the local chain's genesis. The console sends
signed transaction bytes for broadcast and queries the original transaction
hash for finality. If the response is lost, use **Check transaction** after
reloading or **Resend same transaction** while the signature remains valid.
Use these browser wallets with the local profile and virtual funds. Testnet
wallet integration is a separate deployment step.

## Watch a real Sandbox agreement

With the three workers active and online, run:

```sh
docker compose -f deployment/local/compose.yml run --rm demo
```

The demo funds and accepts a new 2-of-3 agreement with disposable accounts,
then has the Master assign it to the three existing workers. Open the SLA ID
it prints in **Agreements**. The window starts after about 45 seconds. The
workers take their own HTTP measurements and report on the local chain. With
the demo target healthy, the agreement ends in a refund to the provider. The
runner verifies the transfer and callback and prints the receipt IDs. The
console shows the finalized outcome and payment status. **Download JSON**
saves the selected oracle's canonical evidence after the console checks the
agreement, the oracle roster, the vote masks and the SHA-256 digest against
the finalized contract state. Evidence files arrive shortly after votes.
Older bundles remain verifiable and show missing control data as **Not recorded**.
The console mounts only the dedicated evidence volumes read-only. The worker
keeps its vote key and database in a separate volume. This command can
exercise the workers and receipts without preparing a browser wallet.

### Compare a target outage with lost control reachability

On an idle demo stack, run these commands one at a time. Each case creates
its own accepted agreement and prints the SLA ID to open in **Agreements**.
Use the Compose project and port configured for that stack.

```sh
docker compose -f deployment/local/compose.yml run --rm demo node local/demo.mjs outage
docker compose -f deployment/local/compose.yml run --rm demo node local/demo.mjs control-loss
```

| Scenario | Slot evidence | Verified settlement |
| --- | --- | --- |
| `outage` | The controlled target returns HTTP 503. The control endpoint responds. The oracles report Down. | The same quorum confirms the streak. The customer claims 0.1 Sandbox NEAR. |
| `control-loss` | The same target returns HTTP 503 while the shared demo control drops connections. The oracles report Unknown and record `LOCAL_FAULT/CONTROL`. | The contract marks the result inconclusive and the provider reclaims 0.1 Sandbox NEAR. |

The runner checks all three evidence timelines against the finalized votes
and prints the transfer and callback IDs. The target and control schedule
applies across the stack and ends automatically, including after an
interrupted run. Each new demo waits for a fresh observation window.

On a paid agreement, open **Verify settlement receipts** and paste the claim
transaction hash printed by the runner. The console uses the agreement's
beneficiary to verify the claim and its two receipts. The demo runner saves
final receipts when it settles. The console checks recorded receipts against
the current finalized agreement and labels their source. Other claims are
looked up through the Sandbox RPC. The verified hash is added to the local
page URL so the next viewer can repeat the check.

## Exercise service failures

You can stop one local service and watch the console update:

```sh
docker compose -f deployment/local/compose.yml stop control
docker compose -f deployment/local/compose.yml start control
```

The control service and target have distinct ports. The worker's control
diagnostic reflects transport reachability and appears in the next signed
heartbeat, normally within 30 seconds. A 503 while the configured control
is unavailable remains visible as a target response and is counted as
**Unknown** in the vote. The on-chain verdict still depends on the agreement's
quorum and required streak. Stop `master` or a named
`oracle-1`, `oracle-2` or `oracle-3` service to exercise recovery. The
services share the Sandbox container's network namespace to keep the
existing loopback safety checks. Each worker has its own identity, scoped
vote key and SQLite volume.

```sh
docker compose -f deployment/local/compose.yml down
```

`down` preserves the database, chain, configuration and worker volumes. Run
the startup command again to resume. To use a different host port, set
`SLA_LOCAL_PORT` consistently and open the corresponding `127.0.0.1` URL.
Use another Compose project and port for a fresh chain after changing the
escrow Wasm. For a remote Testnet deployment, use the
[separate Master and Oracle profiles](deployment.md).
