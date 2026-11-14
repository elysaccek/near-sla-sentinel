# Publish the Testnet demo on one Ubuntu server

For `slasentinel.com`, route the existing Cloudflare Tunnel directly to
`http://127.0.0.1:8790`. Only the read-only website publishes a host
listener. The Master, A/B/C workers, target, runner and PostgreSQL use
Docker networking. The public profile returns 404 for the Sandbox
console and its APIs. Port 8790 is configurable and avoids the reported
SSH, Nginx, cloudflared, and application listeners.
[Cloudflare local tunnel configuration](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/configuration-file/)

## Install from GitHub

On a fresh Ubuntu host with Git, run as root:

```sh
git clone https://github.com/elysaccek/near-sla-sentinel.git /opt/sla-sentinel && sh /opt/sla-sentinel/deployment/testnet/install-ubuntu.sh
```

For an existing checkout, run `sh /opt/sla-sentinel/deployment/testnet/install-ubuntu.sh`
as root after updating it to the intended release. The installer builds
from that checkout. It installs Docker Engine and Compose from Docker's
Ubuntu repository when Docker is absent, then builds the service images,
provisions a dedicated Testnet deployment, enables startup on boot, and
checks the local feed for the runner and all three oracles. The default
fresh provider reserve is 1 Testnet NEAR. Each new agreement escrows
0.01 Testnet NEAR in compensation plus storage funding.

The installer uses NEAR's Testnet faucet and waits for the sponsor
account and key to be visible in finalized state. If the faucet or RPC
is temporarily unavailable, rerun the same command after it recovers.
The bootstrap ID and key stay under `/var/lib/sla-sentinel/bootstrap`.
The installer resumes with the same sponsor after a partial setup and
uses the saved deployment record after provisioning completes. The Wasm
used for fresh provisioning is fetched from the reviewed Testnet release
and checked against pinned hashes before deployment.

Set `SLA_PRODUCT_PORT` in `/etc/sla-sentinel/testnet.conf` before running
the installer if TCP 8790 is already in use. Use the same port in the
tunnel origin.
[Docker Engine on Ubuntu](https://docs.docker.com/engine/install/ubuntu/)

## Set up the existing tunnel

Find the active configuration path on the server. In its existing
`ingress` list insert the entry from
[`cloudflared-ingress.yml`](../deployment/testnet/cloudflared-ingress.yml)
before any matching wildcard or catch-all. Keep other routes, the
tunnel UUID, the credentials path, and the last catch-all. If the
loopback port was changed, update the tunnel origin to match. Use the
same tunnel UUID for the Cloudflare DNS record.

```sh
cloudflared tunnel --config /etc/cloudflared/config.yml ingress validate
cloudflared tunnel --config /etc/cloudflared/config.yml ingress rule https://slasentinel.com/testnet
```

Substitute the actual config path. If the DNS route is missing, add a
proxied CNAME for the apex domain pointing to the existing tunnel's
`<UUID>.cfargotunnel.com`, or use
`cloudflared tunnel route dns <UUID> slasentinel.com` with an authorized
Cloudflare CLI account. Reload the existing service after validation.
If it carries the active SSH session, keep an independent recovery
session before restarting it.

```sh
systemctl restart cloudflared.service
systemctl is-active cloudflared.service
systemctl is-enabled cloudflared.service
```

[Cloudflare DNS and local tunnel setup](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/create-local-tunnel/)

## Move an existing deployment

To move an existing deployment and its history, restore its private
Docker state before running the installer. Build the server images
first. At cutover, verify the source runner has no active agreement and
quiesce it, the workers and the Master. Take a consistent backup. Use a
logical PostgreSQL dump for the Master across host architectures. The
remaining named volumes carry the account registry, key permissions,
operator auth, worker state, signed transaction recovery data, evidence
and published history. Transfer them privately over SSH with file
ownership and modes preserved. Keep the source stopped after cutover
so that one runner uses the funded provider account.

After installing, inspect service state with:

```sh
cd /opt/sla-sentinel
systemctl is-enabled docker.service sla-sentinel-testnet.service
systemctl status sla-sentinel-testnet.service --no-pager
docker compose -f deployment/testnet/compose.yml ps
```

The boot unit reconciles Compose in dependency order using the installed
images. Runtime restart policies allow containers to recover between boots.
[Docker restart policies](https://docs.docker.com/engine/containers/start-containers-automatically/)

## Check the public release

```sh
curl -fsS https://slasentinel.com/healthz
curl -fsS https://slasentinel.com/testnet >/dev/null
curl -fsS https://slasentinel.com/api/testnet/activity
curl -sS -o /dev/null -w '%{http_code}\n' https://slasentinel.com/console
ss -ltn '( sport = :8790 )'
```

Confirm that `live.updatedAt` advances, the three workers are online, and
the latest Testnet rows point to the intended contract. The console check
should return 404. The new listener should bind only to `127.0.0.1`.
