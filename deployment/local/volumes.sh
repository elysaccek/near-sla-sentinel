#!/bin/sh
set -eu

for name in master-auth console-auth bootstrap-auth demo-state chain escrow assignment-public oracle-1 oracle-2 oracle-3 \
  oracle-1-evidence oracle-2-evidence oracle-3-evidence; do
  chmod 0700 "/data/$name"
  chown 1000:1000 "/data/$name"
done
chmod 0750 /data/postgres-auth
chown 1000:999 /data/postgres-auth
exec node local/credentials.mjs
