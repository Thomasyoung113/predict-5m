#!/usr/bin/env bash
# Autonomous background daemon for 5-minute Bitcoin paper predictor
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] starting predict-5m daemon..." >> predict5m.log

while true; do
  node predictor.js watch >> predict5m.log 2>&1
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] predict-5m exited ($?), restarting in 5s..." >> predict5m.log
  sleep 5
done
