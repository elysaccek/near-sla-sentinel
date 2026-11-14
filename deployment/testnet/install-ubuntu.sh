#!/bin/sh
# Run as root from the committed checkout at /opt/sla-sentinel.
set -eu
umask 077

cd "$(dirname "$0")/../.."
if [ "$(id -u)" -ne 0 ] || [ "$(pwd -P)" != /opt/sla-sentinel ]; then
  echo "Run as root from the checkout at /opt/sla-sentinel." >&2
  exit 1
fi

exec 9>/run/lock/sla-sentinel-testnet-install.lock
flock -n 9 || { echo "Another SLA Sentinel installation is running." >&2; exit 1; }

if [ ! -x /usr/bin/docker ]; then
  echo "Installing Docker Engine and Compose from Docker's Ubuntu repository."
  . /etc/os-release
  [ "$ID" = ubuntu ] || { echo "Use Ubuntu or install Docker Engine and Compose first." >&2; exit 1; }
  apt-get update
  apt-get install -y ca-certificates curl
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod 0644 /etc/apt/keyrings/docker.asc
  cat > /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: ${UBUNTU_CODENAME:-$VERSION_CODENAME}
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
  chmod 0644 /etc/apt/sources.list.d/docker.sources
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi

/usr/bin/docker compose version >/dev/null
systemctl enable --now docker.service

install -d -m 0750 /etc/sla-sentinel
config=/etc/sla-sentinel/testnet.conf
if [ ! -e "$config" ]; then
  install -m 0640 /dev/null "$config"
  printf '%s\n' 'SLA_PRODUCT_PORT=8790' >> "$config"
fi
compose() {
  /usr/bin/docker compose --env-file "$config" -f deployment/testnet/compose.yml "$@"
}
bootstrap_node() {
  compose run --rm --no-deps -T --entrypoint node "$@"
}

echo "Building the Testnet services from this checkout."
compose build init database-init web
compose run --rm --no-deps -T init
contract=$(bootstrap_node provision live/bootstrap.mjs installed)

if [ -z "$contract" ]; then
  if ! command -v curl >/dev/null 2>&1; then
    apt-get update
    apt-get install -y ca-certificates curl
  fi
  bootstrap=/var/lib/sla-sentinel/bootstrap
  install -d -m 0700 /var/lib/sla-sentinel
  install -d -m 0700 -o 1000 -g 1000 "$bootstrap"
  if [ ! -e "$bootstrap/sponsor-id" ]; then
    sponsor_id=$(mktemp "$bootstrap/sponsor-id.XXXXXX")
    printf 'sla-vps-%s.testnet\n' "$(cat /proc/sys/kernel/random/uuid | cut -c1-16)" > "$sponsor_id"
    mv -- "$sponsor_id" "$bootstrap/sponsor-id"
  fi
  sponsor=$(cat "$bootstrap/sponsor-id")
  public_key=$(bootstrap_node -v "$bootstrap:/bootstrap" provision live/bootstrap.mjs sponsor "$sponsor")
  if [ -n "$public_key" ]; then
    echo "Requesting the dedicated Testnet sponsor from the faucet."
    # The response can fail after the faucet submits. Finalized state decides whether to continue.
    if ! curl -4 -fsS --connect-timeout 10 --max-time 40 -o /dev/null \
        -H 'Content-Type: application/json' \
        --data "{\"newAccountId\":\"$sponsor\",\"newAccountPublicKey\":\"$public_key\"}" \
        https://helper.nearprotocol.com/account; then
      echo "The faucet request failed. Checking Testnet finality before stopping." >&2
    fi
    bootstrap_node -v "$bootstrap:/bootstrap" provision live/bootstrap.mjs confirm-sponsor "$sponsor"
  fi
  echo "Provisioning the Testnet accounts and reviewed escrow."
  compose run --rm --no-deps -T -e "SLA_DEMO_SPONSOR=$sponsor" -v "$bootstrap:/bootstrap:ro" \
    provision node live/provision.mjs --provider-reserve 1 --submit
  contract=$(bootstrap_node provision live/bootstrap.mjs installed)
  [ -n "$contract" ] || { echo "The Testnet deployment record is missing." >&2; exit 1; }
fi

install -m 0644 deployment/testnet/sla-sentinel-testnet.service /etc/systemd/system/sla-sentinel-testnet.service
systemctl daemon-reload
systemctl enable sla-sentinel-testnet.service
if systemctl is-active --quiet sla-sentinel-testnet.service; then
  compose up --detach --wait --wait-timeout 180
else
  systemctl start sla-sentinel-testnet.service
fi

echo "Waiting for the runner and three observers to publish their Testnet status."
compose exec -T web node - "$contract" <<'JS'
const { setTimeout: sleep } = require("node:timers/promises");
const [contract] = process.argv.slice(2);
const activePhases = new Set(["waiting", "funding", "scheduled", "observing", "reporting", "settling"]);
async function waitForFeed() {
  for (let attempt = 0; attempt < 45; attempt++) {
    try {
      const response = await fetch("http://127.0.0.1:8790/api/testnet/activity", { signal: AbortSignal.timeout(1500) });
      const { live } = await response.json();
      if (response.ok && live.contract === contract && activePhases.has(live.phase)
          && ["oracle-a", "oracle-b", "oracle-c"].every(id =>
            live.observers?.some(observer => observer.id === id && observer.state === "online"))) return;
    } catch {}
    await sleep(2000);
  }
  throw new Error("The Testnet runner or workers are not ready. Check the Compose runner and oracle logs.");
}
waitForFeed().catch(error => { console.error(error.message); process.exitCode = 1; });
JS
echo "Testnet escrow $contract is ready."
echo "Web origin http://$(compose port web 8790)/testnet"
