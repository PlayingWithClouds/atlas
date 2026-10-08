#!/usr/bin/env bash
# Typechecks every server/contracts/plugin tsconfig, then svelte-checks the web app and each
# plugin web config. Exits non-zero if any step fails.
set -u
root="$(cd "$(dirname "$0")/.." && pwd)"
svelteCheck="$root/packages/web/node_modules/.bin/svelte-check"
failures=0

run() {
  echo "==> $1"
  shift
  "$@" || failures=$((failures + 1))
}

for config in "$root"/packages/contracts/tsconfig.json "$root"/packages/server/tsconfig.json "$root"/plugins/*/tsconfig.json; do
  run "tsc ${config#"$root"/}" "$root/node_modules/.bin/tsc" --noEmit -p "$config"
done

run "svelte-check packages/web" "$svelteCheck" --tsconfig "$root/packages/web/tsconfig.json" --threshold error
for config in "$root"/plugins/*/tsconfig.web.json; do
  run "svelte-check ${config#"$root"/}" "$svelteCheck" --tsconfig "$config" --threshold error
done

exit "$failures"
