#!/usr/bin/env bash
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec node "$ROOT/scripts/autonomous-controller.mjs" "$@"
