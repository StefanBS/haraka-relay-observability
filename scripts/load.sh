#!/usr/bin/env bash
# Steady drip: one message per INTERVAL seconds until Ctrl-C.
set -uo pipefail

INTERVAL=${INTERVAL:-1}
DIR=$(dirname "$0")
i=0

trap 'echo; echo "sent $i messages total"; exit 0' INT TERM

while true; do
  i=$((i + 1))
  if "$DIR/send-mail.sh" "load #$i" >/dev/null 2>&1; then
    echo "sent #$i"
  else
    echo "REJECTED #$i (relay tempfailed: back-pressure or relay down)"
  fi
  sleep "$INTERVAL"
done
