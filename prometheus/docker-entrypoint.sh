#!/bin/sh
set -e
sed "s/__QUEUE_AGE_THRESHOLD__/${QUEUE_AGE_THRESHOLD:-60}/" \
  /etc/prometheus/alerts.yml.tmpl > /prometheus/alerts.yml
exec /bin/prometheus \
  --config.file=/etc/prometheus/prometheus.yml \
  --storage.tsdb.path=/prometheus
