#!/bin/bash
# End-to-end check on a real box: start it, check the viewer needs its password,
# drive Chromium with playwright-cli, type vault entries into the right page
# (and refuse the wrong one), download and upload a file, check the time zone
# and keep-awake, restart and check logins survived, then remove the box.
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
export BOX_PREPARE_WAIT=${BOX_PREPARE_WAIT:-900}   # the first run may build the image
BOX=$PWD/agent-box
RT=$("$BOX" runtime)
WORK=$(mktemp -d)
cd "$WORK"

step() { printf '\n== %s\n' "$*"; }
fail() { echo "FAIL: $*" >&2; "$BOX" logs 2>&1 | tail -n 40 >&2 || true; exit 1; }
pw() { playwright-cli -s=smoke "$@"; }
result() { pw eval "$1" 2>&1 | grep -A1 '^### Result' | tail -n 1; }   # value of a JS expression
ref() {   # ref of the element with this role and name, from a fresh page snapshot
  local out file
  out=$(pw snapshot 2>&1 || true)
  # Small pages come back inline; bigger ones as a file the output links to.
  file=$(printf '%s\n' "$out" | sed -n 's/.*(\(\.playwright-cli\/page-[^)]*\.yml\)).*/\1/p' | tail -n 1)
  if [ -n "$file" ] && [ -f "$file" ]; then out=$(cat "$file"); fi
  printf '%s\n' "$out" | grep "$1 \"$2\"" | tail -n 1 | sed -n 's/.*\[ref=\([a-z0-9]*\)\].*/\1/p' || true
}
tab_index() { pw tab-list 2>&1 | grep -F "$1" | head -n 1 | sed -n 's/^- \([0-9]*\):.*/\1/p'; }
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
trap 'echo "FAIL: line $LINENO: $BASH_COMMAND" >&2; "$BOX" logs 2>&1 | tail -n 40 >&2 || true' ERR

step "start the box ($RT)"
"$BOX" up
curl -sf "http://127.0.0.1:$BOX_CDP_PORT/json/version" >/dev/null || fail "no browser control on $BOX_CDP_PORT"
curl -sf "http://127.0.0.1:$BOX_VIEW_PORT/vnc.html" >/dev/null || fail "no viewer on $BOX_VIEW_PORT"

step "the viewer needs its password, and its start page carries it"
curl -sf "http://127.0.0.1:$BOX_VIEW_PORT/" | grep 'password=[A-Za-z0-9]\{8\}' >/dev/null || fail "the viewer link has no password"
types=$("$BOX" exec python3 -c 'import socket
s = socket.create_connection(("127.0.0.1", 5900), timeout=5); s.recv(12); s.sendall(b"RFB 003.008\n")
n = s.recv(1)[0]; print(list(s.recv(n)) if n else [])')
[ "$types" = "[2]" ] || fail "VNC offers security types $types; expected only a password (2)"

step "a sign-in form on example.com in tab A, and tab B in front"
pw attach --cdp="http://127.0.0.1:$BOX_CDP_PORT" >/dev/null
pw tab-new >/dev/null
pw goto https://example.com >/dev/null   # goto waits for the page to load
result "() => { document.body.innerHTML = '<form onsubmit=\"window.sent = (window.sent || 0) + 1; return false\"><input placeholder=user><input type=password placeholder=pass><button>Sign in</button></form>'; return 'form' }" >/dev/null
user=$(ref textbox user); pass=$(ref textbox pass)
[ -n "$user" ] && [ -n "$pass" ] || fail "form fields not found in the snapshot"
printf 'smoke-pw-%s' "$RANDOM" > pw.txt
"$BOX" secret save "Smoke test" --from-file pw.txt --user smoke@example.com --url https://example.com
"$BOX" secret list | grep -x "Smoke test" >/dev/null || fail "entry not listed"
pw click "$user" >/dev/null; "$BOX" type-secret "Smoke test" --username
pw click "$pass" >/dev/null
pw tab-new 'data:text/html,<title>Tab B</title><input placeholder=search autofocus>' >/dev/null

step "type-secret types into tab A, not the search box in front"
"$BOX" type-secret "Smoke test" --no-enter
[ "$(result "() => document.querySelector('input').value.length")" = 0 ] || fail "the password went into tab B"
pw tab-select "$(tab_index example.com)" >/dev/null
got=$(result "() => document.querySelector('input').value + ' ' + (document.querySelector('[type=password]').value === '$(cat pw.txt)')")
[ "$got" = '"smoke@example.com true"' ] || fail "typed values were wrong: $got"

step "type-secret refuses another site's entry and a field of the wrong kind"
printf 'other-%s' "$RANDOM" > other.txt
"$BOX" secret save "Other site" --from-file other.txt --user x@example.org --url https://example.org
rc=0; "$BOX" type-secret "Other site" --no-enter || rc=$?
[ "$rc" = 5 ] || fail "typed another site's password (exit $rc)"
pw click "$user" >/dev/null
rc=0; "$BOX" type-secret "Smoke test" --no-enter || rc=$?
[ "$rc" = 3 ] || fail "typed a password into a text field (exit $rc)"

step "Enter submits the form, then the password field is emptied"
result "() => { document.querySelector('[type=password]').value = ''; return 'reset' }" >/dev/null
pw click "$pass" >/dev/null
"$BOX" type-secret "Smoke test"
got=$(result "() => (window.sent || 0) + ' ' + document.querySelector('[type=password]').value.length")
[ "$got" = '"1 0"' ] || fail "expected one submit and an empty password field, got $got"
"$BOX" secret rm "Smoke test" >/dev/null; "$BOX" secret rm "Other site" >/dev/null

step "a download lands where agent-box files and get find it"
result "() => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['smoke download'])); a.download = 'smoke-download.txt'; document.body.append(a); a.click(); return 'clicked' }" >/dev/null
for _ in $(seq 20); do "$BOX" files | grep 'smoke-download.txt$' >/dev/null && break; sleep 0.5; done
"$BOX" files | grep 'smoke-download.txt$' >/dev/null || fail "the download isn't listed"
"$BOX" get smoke-download.txt "$WORK/" >/dev/null
[ "$(cat "$WORK/smoke-download.txt")" = "smoke download" ] || fail "the downloaded file's content is wrong"

step "an upload from this machine reaches the page"
printf 'upload from the host' > up.txt
result "() => { document.body.insertAdjacentHTML('beforeend', '<input type=file aria-label=attachment>'); return 'added' }" >/dev/null
pw click "$(ref button attachment)" >/dev/null 2>&1 || true
pw upload "$WORK/up.txt" >/dev/null
got=$(result "() => { const f = document.querySelector('[type=file]').files[0]; return f ? f.name + ':' + f.size : 'none' }")
[ "$got" = '"up.txt:20"' ] || fail "the page didn't get the upload: $got"

step "screenshot of the desktop"
"$BOX" shot "$WORK/shot.png" >/dev/null
[ "$(head -c 4 shot.png | tail -c 3)" = PNG ] || fail "screenshot isn't a PNG"

step "the browser uses the host's time zone; hold keeps the box awake"
tz=$("$BOX" exec printenv TZ)
got=$(result "() => Intl.DateTimeFormat().resolvedOptions().timeZone")
case "$tz:$got" in "$tz:\"$tz\""|UTC:\"Etc/UTC\"|Etc/UTC:\"UTC\") ;; *) fail "browser time zone $got, box TZ $tz" ;; esac
"$BOX" hold 5 >/dev/null
"$BOX" status | grep 'kept awake' >/dev/null || fail "status doesn't show the hold"
"$BOX" hold 0 >/dev/null
{ "$BOX" doctor || true; } | grep "ok   box is running" >/dev/null || fail "doctor does not see the box"

step "tab cleanup: idle tabs are closed; typed input and the last tab are kept"
"$BOX" exec pgrep -f 'box-tidy watch' >/dev/null || fail "the tab watcher isn't running"
"$BOX" exec pgrep -x earlyoom >/dev/null || fail "earlyoom isn't running"
pw tab-new https://example.net/ >/dev/null                     # a tab nobody typed in
pw tab-new https://example.org/ >/dev/null
result "() => { document.body.insertAdjacentHTML('beforeend', '<input aria-label=draft>'); document.querySelector('[aria-label=draft]').value = 'unsent'; return 'typed' }" >/dev/null
"$BOX" tabs | grep 'typed input' | grep 'example.org' >/dev/null || fail "'tabs' doesn't mark the tab with typed input"
"$BOX" tidy 0 >/dev/null
"$BOX" tabs | grep 'example.org' >/dev/null || fail "tidy closed a tab with typed input"
if "$BOX" tabs | grep 'example.net' >/dev/null; then fail "tidy left an idle tab open"; fi
"$BOX" tidy log | grep 'closed example.net' >/dev/null || fail "the log doesn't name the closed tab"
# Memory pressure, simulated with a floor no box can meet: idle tabs go, the typed one stays.
pw tab-new https://example.net/ >/dev/null
out=$("$BOX" exec box-tidy pressure --floor-mb 999999 --goal-mb 999999 --grace 0)
[[ "$out" == *"closed example.net"* ]] || fail "memory pressure didn't close the idle tab: $out"
"$BOX" tabs | grep 'example.org' >/dev/null || fail "memory pressure closed a tab with typed input"
# Even with --force, which also closes tabs holding typed input, one tab always stays.
"$BOX" exec box-tidy run --older-than 0 --force >/dev/null
[ "$("$BOX" tabs | head -n 1 | cut -d' ' -f1)" = 1 ] || fail "expected exactly one tab left: $("$BOX" tabs | head -n 1)"
pw tab-new >/dev/null
pw goto https://example.com >/dev/null

step "logins survive a restart, session-only ones too"
result "() => { document.cookie = 'smoke=kept; max-age=3600; path=/'; document.cookie = 'session=kept; path=/'; return document.cookie }" >/dev/null
pw detach >/dev/null
"$BOX" down
"$BOX" up >/dev/null
pw attach --cdp="http://127.0.0.1:$BOX_CDP_PORT" >/dev/null
pw tab-new >/dev/null
pw goto https://example.com >/dev/null
got=$(result "() => document.cookie")
[[ "$got" == *smoke=kept* ]] || fail "cookie lost after restart: $got"
[[ "$got" == *session=kept* ]] || fail "session cookie lost after restart: $got"

echo; echo "PASS: smoke test on $RT"
