#!/bin/sh
set -e
mkdir -p /data/queue
printf 'temp_fail_intervals=%s\n' "${RETRY_INTERVAL:-30s*20}" \
  > /app/haraka/config/outbound.ini
exec haraka -c /app/haraka
