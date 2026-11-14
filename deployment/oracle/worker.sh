#!/bin/sh
set -eu

if [ "$#" -eq 1 ] && [ "$1" = run ]; then
  set -- run --assignment-pub /run/sla-sentinel/assignment-public.der \
    --contract "$SLA_ORACLE_CONTRACT" --code-hash "$SLA_ORACLE_CODE_HASH" \
    --endpoint "$SLA_ORACLE_ENDPOINT"
  if [ -n "${SLA_ORACLE_CONTROL_1:-}" ]; then
    set -- "$@" --control-endpoint "$SLA_ORACLE_CONTROL_1"
  fi
  if [ -n "${SLA_ORACLE_CONTROL_2:-}" ]; then
    set -- "$@" --control-endpoint "$SLA_ORACLE_CONTROL_2"
  fi
fi

exec node src/commands/worker-cli.ts "$@" --state-dir /state
