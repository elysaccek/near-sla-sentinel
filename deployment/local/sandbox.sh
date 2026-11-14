#!/bin/sh
set -eu
umask 077

if [ ! -s /chain/config.json ]; then
  near-sandbox --home /chain init --fast --account-id test.near --chain-id test-chain-sla-sentinel
fi
exec near-sandbox --home /chain run --rpc-addr 127.0.0.1:34831 --network-addr 127.0.0.1:34832
