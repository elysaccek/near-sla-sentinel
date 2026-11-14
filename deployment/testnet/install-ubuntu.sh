#!/bin/sh
# Run as root from the committed checkout at /opt/sla-sentinel.
set -eu

cd "$(dirname "$0")/../.."
if [ "$(id -u)" -ne 0 ] || [ "$(pwd -P)" != /opt/sla-sentinel ]; then
  echo "Run as root from the checkout at /opt/sla-sentinel." >&2
  exit 1
fi
/usr/bin/docker compose version >/dev/null
systemctl enable --now docker.service

install -d -m 0750 /etc/sla-sentinel
if [ ! -e /etc/sla-sentinel/testnet.conf ]; then
  install -m 0640 /dev/null /etc/sla-sentinel/testnet.conf
  printf '%s\n' 'SLA_PRODUCT_PORT=8790' >> /etc/sla-sentinel/testnet.conf
fi

# Build once during installation or a deployment update. Boot uses local images.
/usr/bin/docker compose -f deployment/testnet/compose.yml build
install -m 0644 deployment/testnet/sla-sentinel-testnet.service /etc/systemd/system/sla-sentinel-testnet.service
systemctl daemon-reload
systemctl enable sla-sentinel-testnet.service
if systemctl is-active --quiet sla-sentinel-testnet.service; then
  systemctl restart sla-sentinel-testnet.service
else
  systemctl start sla-sentinel-testnet.service
fi
