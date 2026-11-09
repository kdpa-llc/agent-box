#!/usr/bin/env python3
"""Front door for the agent box viewer, always on at 127.0.0.1:6080.

Tailscale Serve points the phone address here. If the box is running, each
connection passes straight through to the box's viewer (HTTP and WebSocket
alike). If the box is off, the door starts it and answers with a small page
that reloads itself until the viewer is up, or shows why the start failed.
It starts the box only for a page someone opened, not for a request a web page
makes in the background. Uses about 15 MB of memory.
"""
import asyncio
import html
import os
import re
import subprocess
import time

LISTEN = ("127.0.0.1", int(os.environ.get("DOOR_PORT", 6080)))
BOX_VIEWER = ("127.0.0.1", int(os.environ.get("DOOR_BOX_PORT", 6090)))   # where `agent-box up` publishes the viewer
BOX_CMD = os.path.join(os.path.dirname(os.path.realpath(__file__)), "agent-box")
LOG = os.path.join(os.environ.get("XDG_CACHE_HOME") or os.path.expanduser("~/.cache"), "agent-box", "door-up.log")
RETRY_AFTER = 30   # seconds before trying again after a failed start

starting = None      # the running `agent-box up`, if any
last_failure = 0.0   # when the last start failed


def box_starting():
    return starting is not None and starting.poll() is None


def page(title, body, refresh):
    return f"""<!doctype html>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="{refresh}">
<title>Agent box</title>
<body style="font:17px -apple-system,system-ui,sans-serif;padding:2em;line-height:1.4">
<p><b>{title}</b></p>
{body}
</body>
""".encode()


def respond(writer, status, body):
    writer.write(
        b"HTTP/1.1 %s\r\nContent-Type: text/html; charset=utf-8\r\n"
        b"Cache-Control: no-store\r\nConnection: close\r\n"
        b"Content-Length: %d\r\n\r\n" % (status.encode(), len(body)) + body
    )


async def pipe(reader, writer):
    try:
        while data := await reader.read(65536):
            writer.write(data)
            await writer.drain()
    except (ConnectionError, asyncio.CancelledError):
        pass
    finally:
        writer.close()


async def handle(client_r, client_w):
    global starting, last_failure
    if not box_starting():
        try:
            box_r, box_w = await asyncio.wait_for(asyncio.open_connection(*BOX_VIEWER), 1)
        except (OSError, asyncio.TimeoutError):
            pass
        else:
            await asyncio.gather(pipe(client_r, box_w), pipe(box_r, client_w))
            return
    # The box is off or starting. Read the request to see what asked for it.
    try:
        request = await asyncio.wait_for(client_r.read(65536), 2)
    except (OSError, asyncio.TimeoutError):
        request = b""
    mode = re.search(rb"^sec-fetch-mode:\s*([a-z-]+)", request, re.I | re.M)
    if mode and mode.group(1).lower() != b"navigate":
        # Something a web page fetched in the background, not a page someone
        # opened: don't start the box for it.
        respond(client_w, "403 Forbidden", page("Not started", "<p>Open this address in its own tab.</p>", 3600))
    else:
        if starting is not None and not box_starting():   # the last start finished
            if starting.returncode not in (0, 75):         # 75: still preparing the image
                last_failure = time.time()
            starting = None
        if not box_starting() and time.time() - last_failure > RETRY_AFTER:
            last_failure = 0.0
            os.makedirs(os.path.dirname(LOG), exist_ok=True)
            with open(LOG, "w") as log:
                starting = subprocess.Popen([BOX_CMD, "up"], stdin=subprocess.DEVNULL,
                                            stdout=subprocess.DEVNULL, stderr=log)
        if last_failure:
            try:
                with open(LOG) as log:
                    detail = "".join(log.readlines()[-15:])
            except OSError:
                detail = ""
            body = (f"<pre style='white-space:pre-wrap'>{html.escape(detail)}</pre>"
                    f"<p>It tries again in {RETRY_AFTER} seconds. On the computer, "
                    "<code>agent-box doctor</code> shows what's wrong.</p>")
            respond(client_w, "200 OK", page("The agent box didn't start", body, 10))
        else:
            respond(client_w, "200 OK", page(
                "Starting the agent box&hellip;",
                "<p>This page reloads by itself and opens the box in about 10 seconds. "
                "The first start after an install or update takes a few minutes.</p>", 3))
    try:
        await client_w.drain()
    finally:
        client_w.close()


async def main():
    server = await asyncio.start_server(handle, *LISTEN)
    async with server:
        await server.serve_forever()


asyncio.run(main())
