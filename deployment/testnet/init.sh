#!/bin/sh
set -eu
for directory in /registry /master-auth /admin-access /postgres-auth /runner-state /runner-keys /contract-admin /live-public \
  /states/oracle-a /states/oracle-b /states/oracle-c /evidence/oracle-a /evidence/oracle-b /evidence/oracle-c; do
  chmod 0700 "$directory"
  chown 1000:1000 "$directory"
done
for directory in /observers /observers/oracle-a /observers/oracle-b /observers/oracle-c; do
  mkdir -p "$directory"
  chmod 0700 "$directory"
  chown 1000:1000 "$directory"
done
chmod 0750 /postgres-auth
chown 1000:999 /postgres-auth
exec node live/init.mjs
