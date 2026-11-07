#!/bin/bash
# End-to-end check on a real box: start it, drive Chromium with playwright-cli,
# type a vault entry into a form, take a screenshot, restart and check that a
# cookie survived, then remove the box and its storage.
#
#   tests/smoke.sh            uses the container tool from setup (or the default)
#   BOX_RUNTIME=docker tests/smoke.sh
#
# It runs its own test box on other ports with its own storage, so it doesn't
# touch a box that's in use. Needs playwright-cli, and network for example.com.
set -euo pipefail
cd "$(dirname "$0")/.."
export BOX_NAME=agent-box-smoke BOX_VOLUME=agent-box-smoke-data
export BOX_CDP_PORT=${BOX_CDP_PORT:-9522} BOX_VIEW_PORT=${BOX_VIEW_PORT:-6580}
BOX=$PWD/agent-box
RT=$("$BOX" runtime)
WORK=$(mktemp -d)
cd "$WORK"

step() { printf '\n== %s\n' "$*"; }
fail() { echo "FAIL: $*" >&2; "$BOX" logs 2>&1 | tail -n 40 >&2 || true; exit 1; }
pw() { playwright-cli -s=smoke "$@"; }
result() { pw eval "$1" 2>&1 | grep -A1 '^### Result' | tail -n 1; }   # value of a JS expression
ref() {   # ref of the text box with this name, from a fresh page snapshot
  pw snapshot >/dev/null 2>&1
  grep -h "textbox \"$1\"" .playwright-cli/page-*.yml | tail -n 1 | sed -n 's/.*\[ref=\(e[0-9]*\)\].*/\1/p'
}
cleanup() {
  pw detach >/dev/null 2>&1 || true
  "$BOX" down >/dev/null 2>&1 || true
  case "$RT" in
    container) container volume delete "$BOX_VOLUME" >/dev/null 2>&1 || true ;;
    *) "$RT" volume rm "$BOX_VOLUME" >/dev/null 2>&1 || true ;;
  esac
  rm -rf "${WORK:?}"
}
trap cleanup EXIT
trap 'echo "FAIL: line $LINENO: $BASH_COMMAND" >&2' ERR

step "start the box ($RT)"
"$BOX" up
curl -sf "http://127.0.0.1:$BOX_CDP_PORT/json/version" >/dev/null || fail "no browser control on $BOX_CDP_PORT"
curl -sf "http://127.0.0.1:$BOX_VIEW_PORT/vnc.html" >/dev/null || fail "no viewer on $BOX_VIEW_PORT"

step "drive Chromium in a new tab"
pw attach --cdp="http://127.0.0.1:$BOX_CDP_PORT" >/dev/null
pw tab-new 'data:text/html,<input placeholder=user><input type=password placeholder=pass>' >/dev/null
user=$(ref user); pass=$(ref pass)
[ -n "$user" ] && [ -n "$pass" ] || fail "form fields not found in the snapshot"

step "save a vault entry and type it into the form"
printf 'smoke-pw-%s' "$RANDOM" > pw.txt
"$BOX" secret save "Smoke test" --from-file pw.txt --user smoke@example.com --url https://example.com
"$BOX" secret list | grep -qx "Smoke test" || fail "entry not listed"
pw click "$user" >/dev/null; "$BOX" type-secret "Smoke test" --username
pw click "$pass" >/dev/null; "$BOX" type-secret "Smoke test" --no-enter
got=$(result "() => document.querySelector('input').value + ' ' + (document.querySelector('[type=password]').value === '$(cat pw.txt)')")
[ "$got" = '"smoke@example.com true"' ] || fail "typed values were wrong: $got"
"$BOX" secret rm "Smoke test" >/dev/null

step "screenshot of the desktop"
"$BOX" shot "$WORK/shot.png" >/dev/null
[ "$(head -c 4 shot.png | tail -c 3)" = PNG ] || fail "screenshot isn't a PNG"

step "logins survive a restart"
pw tab-new https://example.com >/dev/null
result "() => { document.cookie = 'smoke=kept; max-age=3600; path=/'; return document.cookie }" >/dev/null
pw detach >/dev/null
"$BOX" down
"$BOX" up >/dev/null
pw attach --cdp="http://127.0.0.1:$BOX_CDP_PORT" >/dev/null
pw tab-new https://example.com >/dev/null
got=$(result "() => document.cookie")
[[ "$got" == *smoke=kept* ]] || fail "cookie lost after restart: $got"

echo; echo "PASS: smoke test on $RT"
