# Agent box: one shared Linux desktop with Chromium for AI agents.
# Same recipe as Anthropic's computer-use demo and E2B's desktop template:
# virtual screen (Xvfb) + light window manager + VNC with a web viewer (noVNC)
# + browser + xdotool. Chromium also exposes CDP so agents can use Playwright.
FROM docker.io/library/debian:trixie-slim
LABEL agent-box=true org.opencontainers.image.source=https://github.com/kdpa-llc/agent-box

ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb x11vnc novnc python3-websockify openbox tint2 keepassxc-minimal \
      chromium xdotool scrot socat iproute2 procps ca-certificates python3-websocket \
      fonts-liberation fonts-dejavu-core fonts-noto-color-emoji xterm \
    && rm -rf /var/lib/apt/lists/* /usr/share/doc/* /usr/share/man/*

# The viewer's start page is written at startup by entrypoint.sh, with the
# viewer password in its link.

# Chromium policies:
# - passwords live in one place (the box's KeePassXC vault), not in Chromium's own store;
# - downloads go to the box's storage, where `agent-box files` and `get` find them,
#   without asking where to save;
# - it reopens the last session at start, which also keeps session-only logins.
RUN mkdir -p /etc/chromium/policies/managed \
    && printf '%s\n' '{"PasswordManagerEnabled": false, "DownloadDirectory": "/data/Downloads",' \
         ' "PromptForDownloadLocation": false, "RestoreOnStartup": 1}' \
         > /etc/chromium/policies/managed/agent-box.json

RUN useradd -m -u 1000 -s /bin/bash agent && mkdir -p /data && chown agent:agent /data
COPY entrypoint.sh box-quit-browser box-vault box-type /usr/local/bin/
RUN chmod 755 /usr/local/bin/entrypoint.sh /usr/local/bin/box-quit-browser /usr/local/bin/box-vault \
      /usr/local/bin/box-type
# Taskbar with a "Passwords" button, and KeePassXC settings (no tray, no update
# checks, never locks by itself, saves after every change).
COPY desktop/tint2rc /etc/xdg/tint2/agent-box.tint2rc
COPY desktop/agent-box-passwords.desktop /usr/share/applications/
COPY desktop/keepassxc.ini /etc/agent-box/keepassxc.ini

WORKDIR /home/agent
EXPOSE 6080 9223
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
