#!/bin/sh
set -e

cd /app/apps/web
mkdir -p data
bun scripts/ensure-db.ts && bunx drizzle-kit push
bun next start --hostname 0.0.0.0 --port 3111
