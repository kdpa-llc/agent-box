#!/bin/bash
# Starts the desktop, viewer, Chromium and the idle watchdog.
# The container exits (and frees its memory) after IDLE_MINUTES with no viewer
# connected and no browser-control traffic. IDLE_MINUTES=0 keeps it running.
set -u
# Start as root only to hand the storage volume to the agent user, then drop root.
if [ "$(id -u)" = 0 ]; then
  chown agent:agent /data
  export HOME=/home/agent USER=agent
  exec setpriv --reuid=agent --regid=agent --init-groups "$0" "$@"
fi
W=${SCREEN_WIDTH:-1280}
H=${SCREEN_HEIGHT:-800}
IDLE_MINUTES=${IDLE_MINUTES:-20}
export DISPLAY=:1
log() { echo "$(date -u +%FT%TZ) $*"; }

mkdir -p /data/profile /data/Downloads
rm -f /data/profile/Singleton*   # stale lock from a previous run

Xvfb :1 -screen 0 "${W}x${H}x24" -nolisten tcp &
for _ in $(seq 50); do xdotool getdisplaygeometry >/dev/null 2>&1 && break; sleep 0.1; done
openbox &
tint2 -c /etc/xdg/tint2/agent-box.tint2rc >/dev/null 2>&1 &
mkdir -p "$HOME/.config/keepassxc" && cp /etc/agent-box/keepassxc.ini "$HOME/.config/keepassxc/"
box-vault init   # the password vault, created on first start

x11vnc -display :1 -localhost -rfbport 5900 -forever -shared -nopw -quiet -bg -o /tmp/x11vnc.log
websockify --web /usr/share/novnc 0.0.0.0:6080 127.0.0.1:5900 >/tmp/websockify.log 2>&1 &

# Chromium only listens for CDP on 127.0.0.1; forward it so the Mac can reach it.
socat TCP-LISTEN:9223,fork,reuseaddr,bind=0.0.0.0 TCP:127.0.0.1:9222 &

# Keep one Chromium running; relaunch it if someone closes the window.
# box-quit-browser sets /tmp/box-stopping to end the loop for a clean stop.
rm -f /tmp/box-stopping
(
  while [ ! -e /tmp/box-stopping ]; do
    chromium --user-data-dir=/data/profile --remote-debugging-port=9222 \
      --no-first-run --no-default-browser-check --start-maximized \
      --password-store=basic --disable-features=Translate --hide-crash-restore-bubble \
      ${CHROMIUM_FLAGS:-} about:blank >/tmp/chromium.log 2>&1
    [ -e /tmp/box-stopping ] && break
    log "chromium exited, restarting"; sleep 1
  done
) &

shutdown() {
  log "stopping: closing Chromium cleanly"
  box-quit-browser
  exit 0
}
trap shutdown TERM INT

log "agent box up: viewer :6080, CDP :9223, screen ${W}x${H}, idle stop ${IDLE_MINUTES}m"

# Idle watchdog. Active = a viewer is connected, or browser-control (CDP) bytes moved.
last_active=$(date +%s); prev=""
while true; do
  sleep 30 & wait $!   # wait lets the stop signal interrupt the sleep
  [ "$IDLE_MINUTES" = 0 ] && continue
  now=$(date +%s)
  viewers=$(ss -Htn state established '( sport = :5900 )' | wc -l)
  # Bytes moved by the CDP forwarder (socat and its per-connection children).
  cdp=$(for p in $(pgrep -x socat); do cat /proc/$p/io 2>/dev/null; done | awk '/^(rchar|wchar)/{s+=$2} END{print s+0}')
  if [ "$viewers" -gt 0 ] || [ "$cdp" != "$prev" ]; then last_active=$now; fi
  prev=$cdp
  if [ $(( now - last_active )) -ge $(( IDLE_MINUTES * 60 )) ]; then
    log "idle for ${IDLE_MINUTES}m"; shutdown
  fi
done
