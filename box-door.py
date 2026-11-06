#!/usr/bin/env python3
"""Front door for the agent box viewer, always on at 127.0.0.1:6080.

Tailscale Serve points the phone address here. If the box is running, each
connection passes straight through to the box's viewer (HTTP and WebSocket
alike). If the box is off, the door starts it and answers with a small page
that reloads itself until the viewer is up. Uses about 15 MB of memory.
"""
import asyncio
import os
import subprocess

LISTEN = ("127.0.0.1", int(os.environ.get("DOOR_PORT", 6080)))
BOX_VIEWER = ("127.0.0.1", int(os.environ.get("DOOR_BOX_PORT", 6090)))   # where `agent-box up` publishes the viewer
BOX_CMD = os.path.join(os.path.dirname(os.path.realpath(__file__)), "agent-box")

PAGE = """<!doctype html>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="3">
<title>Agent box</title>
<body style="font:17px -apple-system,system-ui,sans-serif;padding:2em;line-height:1.4">
<p><b>Starting the agent box&hellip;</b></p>
<p>This page reloads by itself and opens the box in about 10 seconds.</p>
</body>
""".encode()

starting = None   # the running `box up`, if any


def box_starting():
    return starting is not None and starting.poll() is None


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
    global starting
    if not box_starting():
        try:
            box_r, box_w = await asyncio.wait_for(asyncio.open_connection(*BOX_VIEWER), 1)
        except (OSError, asyncio.TimeoutError):
            pass
        else:
            await asyncio.gather(pipe(client_r, box_w), pipe(box_r, client_w))
            return
        starting = subprocess.Popen([BOX_CMD, "up"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        await asyncio.wait_for(client_r.read(65536), 2)   # the request; its content doesn't matter
    except (OSError, asyncio.TimeoutError):
        pass
    client_w.write(
        b"HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n"
        b"Cache-Control: no-store\r\nConnection: close\r\n"
        b"Content-Length: %d\r\n\r\n" % len(PAGE) + PAGE
    )
    try:
        await client_w.drain()
    finally:
        client_w.close()


async def main():
    server = await asyncio.start_server(handle, *LISTEN)
    async with server:
        await server.serve_forever()


asyncio.run(main())
