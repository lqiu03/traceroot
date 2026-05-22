#!/usr/bin/env bash
# Samples queue depth + ClickHouse parts/rows during the load ramp.
OUT="${1:-/c/tmp/loadtest/metrics.csv}"
DC="docker compose -p traceroot-pr-913 -f /c/tmp/traceroot-pr-913/docker-compose.prod.yml"
echo "ts,queue,spans_parts,traces_parts,spans_rows,traces_rows" > "$OUT"
for i in $(seq 1 50); do
  ts=$(date +%s)
  q=$($DC exec -T redis redis-cli LLEN celery 2>/dev/null | tr -d '\r')
  ch=$($DC exec -T clickhouse clickhouse-client -q "SELECT (SELECT count() FROM system.parts WHERE active AND table='spans'), (SELECT count() FROM system.parts WHERE active AND table='traces'), (SELECT count() FROM spans), (SELECT count() FROM traces) FORMAT TSV" 2>/dev/null | tr '\t' ',' | tr -d '\r')
  echo "$ts,${q:-NA},${ch:-NA,NA,NA,NA}" >> "$OUT"
  sleep 2
done
