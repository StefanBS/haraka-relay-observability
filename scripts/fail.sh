#!/usr/bin/env bash
# Failure switch for the upstream, via the toxiproxy API.
# Usage: fail.sh slow | down | reset | status
set -euo pipefail

API="http://localhost:${TOXIPROXY_API_PORT:-8474}"
PROXY=upstream_smtp

case "${1:-status}" in
  slow)
    curl -s -X POST "$API/proxies/$PROXY/toxics" \
      -d '{"name": "slow", "type": "latency", "attributes": {"latency": 3000}}' >/dev/null
    echo "upstream degraded: +3s latency on every hop"
    ;;
  down)
    curl -s -X POST "$API/proxies/$PROXY" -d '{"enabled": false}' >/dev/null
    echo "upstream down: connections refused"
    ;;
  reset)
    curl -s -X DELETE "$API/proxies/$PROXY/toxics/slow" >/dev/null 2>&1 || true
    curl -s -X POST "$API/proxies/$PROXY" -d '{"enabled": true}' >/dev/null
    echo "upstream restored"
    ;;
  status)
    curl -s "$API/proxies"
    echo
    ;;
  *)
    echo "usage: $0 slow | down | reset | status" >&2
    exit 1
    ;;
esac
