# Publish the Testnet demo on one Ubuntu server

For `slasentinel.com`, route the existing Cloudflare Tunnel directly to
`http://127.0.0.1:8790`. Only the read-only website publishes a host
listener. The Master, A/B/C workers, target, runner and PostgreSQL use
Docker networking. The public profile returns 404 for the Sandbox
console and its APIs. Port 8790 is configurable and avoids the reported
SSH, Nginx, cloudflared, and application listeners.
[Cloudflare local tunnel configuration](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/configuration-file/)

## Prepare the origin

Use Docker Engine and Compose v2. Place the released checkout in
`/opt/sla-sentinel` and check that TCP 8790 is free:

```sh
docker compose version
ss -ltn '( sport = :8790 )'
cd /opt/sla-sentinel
docker compose -f deployment/testnet/compose.yml up --build -d --wait web
curl -fsS http://127.0.0.1:8790/healthz
```

The web service can start before chain credentials arrive. It shows
archived public pilot transactions while the live runner is offline.
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

## Put settlement on the server

To continue the existing deployment and its history, transfer its private
Docker state before starting the server's runner. Build the server images
first. At cutover, verify the source runner has no active agreement and
quiesce it, the workers and the Master. Take a consistent backup. Use a
logical PostgreSQL dump for the Master across host architectures. The
remaining named volumes carry the account registry, key permissions,
operator auth, worker state, signed transaction recovery data, evidence
and published history. Transfer them privately over SSH with file
ownership and modes preserved. Keep the source stopped after cutover
so that one runner uses the funded provider account.

For a fresh deployment with a new escrow, use the
[Testnet provisioning instructions](live-testnet.md#start-the-recurring-demo).
Provisioning with the same account IDs against empty volumes cannot
recover the previous private keys or history.

Once the server has the restored state or a freshly provisioned escrow,
install the boot service as root:

```sh
cd /opt/sla-sentinel
sh deployment/testnet/install-ubuntu.sh
systemctl is-enabled docker.service sla-sentinel-testnet.service
systemctl status sla-sentinel-testnet.service --no-pager
docker compose -f deployment/testnet/compose.yml ps
```

The installer enables Docker and a boot unit that reconciles Compose in
dependency order. Runtime restart policies allow containers to recover
between boots. The unit uses existing images at boot. Its optional
`/etc/sla-sentinel/testnet.conf` file can set the origin port and RPC URLs.
The installer builds from the checked-out source before activating the unit.
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
