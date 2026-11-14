#!/bin/sh
set -eu

exec node src/commands/worker-cli.ts run --state-dir /state \
  --assignment-pub /run/assignment/key.der --contract escrow.test.near \
  --code-hash "$(node -p 'require("/escrow/deployment.json").code_hash')" \
  --endpoint http://127.0.0.1:8787/health --control-endpoint http://127.0.0.1:8788/health \
  --evidence-export-dir /evidence
