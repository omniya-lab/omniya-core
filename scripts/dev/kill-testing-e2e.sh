#!/usr/bin/env bash
# Kill e2e Electron/node runners for THIS worktree only.
# Never touches other omniya-core worktrees or Cursor/VSCode Electron apps.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MARKER="$ROOT/node_modules/electron"

echo "Scoped cleanup for: $ROOT"

# node --test whose cwd is this worktree
for pid in $(pgrep -f 'node --test' 2>/dev/null || true); do
  cwd="$(lsof -a -p "$pid" -d cwd 2>/dev/null | awk 'NR==2 {print $NF}')"
  if [[ "$cwd" == "$ROOT" ]]; then
    echo "TERM node --test pid=$pid"
    kill -TERM "$pid" 2>/dev/null || true
  fi
done
sleep 1

# Electron binaries launched from this worktree's node_modules
if pgrep -f "$MARKER" >/dev/null 2>&1; then
  echo "TERM Electrons matching $MARKER"
  pkill -TERM -f "$MARKER" 2>/dev/null || true
  sleep 1
  pkill -9 -f "$MARKER" 2>/dev/null || true
fi

echo "Remaining for this worktree:"
pgrep -fl "$MARKER" || echo "(none)"
