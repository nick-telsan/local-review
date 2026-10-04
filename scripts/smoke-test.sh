#!/bin/sh
# Smoke-test a compiled lr: it starts a feature in a throwaway jj repo, and `lr ui` serves the page,
# its script, and the API. The tests cover behavior; this checks the binary was built whole.
# Usage: scripts/smoke-test.sh <path to lr>
set -eu

lr=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
tmp=$(mktemp -d)
ui_pid=
cleanup() {
  [ -n "$ui_pid" ] && kill "$ui_pid" 2>/dev/null || true
  rm -rf "$tmp"
}
trap cleanup EXIT

export JJ_CONFIG="$tmp/jj-config.toml" LOCAL_REVIEW_HOME="$tmp/home"
unset LR_FEATURE LR_ACTOR CLAUDECODE AI_AGENT
printf 'user.name = "Smoke"\nuser.email = "smoke@example.com"\n' >"$JJ_CONFIG"

repo="$tmp/repo"
jj git init --quiet "$repo"
cd "$repo"
echo hello >README.md
jj commit --quiet -m "Add README"
jj bookmark set --quiet main -r @-

"$lr" --help >/dev/null
"$lr" init
"$lr" feature start smoke --base main
"$lr" status

"$lr" ui --no-open --port 47999 --json >"$tmp/ui.json" &
ui_pid=$!
i=0
until [ -s "$tmp/ui.json" ]; do
  i=$((i + 1))
  [ "$i" -le 50 ] || { echo "lr ui didn't start" >&2; exit 1; }
  sleep 0.2
done

url=$(sed -n 's/.*"url": *"\([^"]*\)".*/\1/p' "$tmp/ui.json")
origin=$(echo "$url" | sed 's|^\(http://[^/]*\)/.*|\1|')
token=$(echo "$url" | sed 's/.*[?&]t=//')

page=$(curl -fsS "$origin/")
script=$(echo "$page" | sed -n 's/.*<script[^>]*src="\([^"]*\)".*/\1/p' | head -n 1)
[ -n "$script" ] || { echo "no script in the page" >&2; echo "$page" >&2; exit 1; }
curl -fsS -o /dev/null "$origin/${script#/}"
curl -fsS -H "Authorization: Bearer $token" "$origin/api/features" | grep -q '"smoke"'
echo "Smoke test passed: $("$lr" --help | head -n 1)"
