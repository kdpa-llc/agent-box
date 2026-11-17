# The login broker and the phone app

How an agent asks the user for a sign-in, and how the answer reaches the box. This file is the
contract between the broker (`box-broker.mjs`), the command (`agent-box login`, `agent-box broker`)
and the phone app (`app/`). Change it in the same commit as the code.

## What it does

An agent that reaches a sign-in page runs `agent-box login <site>`. The broker, a small service on
the machine that runs the box, sends a notification to the user's phone. The user opens the Agent
Box app, fills the username and password (the iPhone keyboard can fill them from a password
manager) and taps Send. The broker types them into the page in the box. The values are used once
and never stored, and they never reach the agent's output.

Three kinds of request:

| Kind          | The app shows                                   | The agent then                                  |
| ------------- | ----------------------------------------------- | ----------------------------------------------- |
| `credentials` | Username and password fields, Send, Deny        | types each into the field it clicked            |
| `code`        | One field for a code sent by text, email or app | has it typed into the focused code field        |
| `handoff`     | What to do, a link to the live view, Done, Can't | continues once the user taps Done               |

## Parts

- **`box-broker.mjs`**: Node, no dependencies. `node box-broker.mjs run` is the service. The same
  file (or a sibling) holds the client that `agent-box login` and `agent-box broker` call.
- **Phone listener**: HTTP on `127.0.0.1:$BOX_BROKER_PORT` (default 6070). It serves the app's
  files and `/api/*`. Tailscale Serve publishes it to the user's own devices:
  `tailscale serve --bg --https=8444 http://127.0.0.1:6070`.
- **Agent listener**: HTTP on a Unix socket, `$BOX_BROKER_DIR/agent.sock` (mode 600). Only programs
  of the same user can reach it. Web pages and other devices can't, so they can't create requests.
- **State**: `$BOX_BROKER_DIR/state.json` (mode 600, folder mode 700). `BOX_BROKER_DIR` defaults to
  `${XDG_CONFIG_HOME:-$HOME/.config}/agent-box/broker`. It holds the push keys, the paired phones
  (token hashes, push subscriptions) and the history. Requests and the values typed for them live
  in memory only.
- **`app/`**: the phone app, plain HTML, CSS and JavaScript with no build step:
  `index.html`, `app.css`, `app.js`, `sw.js`, `manifest.webmanifest`, `icon-180.png`,
  `icon-192.png`, `icon-512.png`.

## Rules for values

A value is a username, a password or a code that the user sent.

- Values live in the broker's memory, as Buffers that are zeroed when dropped. They are never
  written to disk, logs, history, error messages or any API response.
- No agent endpoint returns a value. The broker types a value by running
  `agent-box type-stdin` with the value on stdin (see "Typing").
- Each value is used once. A password or code is dropped as soon as it has been typed (exit 0).
  The username is dropped with the password. Whatever is left is dropped when its hold runs out.
- Holds: `credentials` values for `BOX_BROKER_HOLD_SECONDS` (default 300) after the answer, a
  `code` for 120 seconds.

## Request

```json
{
  "id": "r_k3v9x2m8",
  "kind": "credentials",
  "site": "github.com",
  "page": { "title": "Sign in to GitHub", "url": "https://github.com/login" },
  "agent": "Claude: publish the package",
  "note": null,
  "viewerUrl": null,
  "status": "pending",
  "createdAt": 1700000000000,
  "expiresAt": 1700001800000
}
```

- `id`: `r_` and 8 random characters.
- `site`: a host name, lower case, with no scheme, path or leading `www.`.
- `page`: what the broker itself saw in the box for that site, the title and the address without
  its query or fragment. The app shows it, so the user sees the real page and not the agent's word.
- `agent`: an optional label, at most 60 characters. `note`: at most 200 characters, required for
  `handoff`. `viewerUrl`: `handoff` only, an `https://` address or `http://127.0.0.1…`, or null.
- Times are milliseconds since 1970. A request expires `BOX_BROKER_REQUEST_MINUTES` (default 30)
  after it was made.

Status:

| Status      | Meaning                                                                    |
| ----------- | -------------------------------------------------------------------------- |
| `pending`   | Waiting for the phone                                                      |
| `ready`     | Answered; values are held until the agent has them typed (`credentials`, `code`) |
| `done`      | The password or code was typed, or the user tapped Done                    |
| `unused`    | Answered, but the hold ran out before the password or code was typed       |
| `denied`    | The user tapped Deny or Can't                                              |
| `expired`   | Nobody answered in time                                                    |
| `cancelled` | The agent withdrew it                                                      |

Every status after `ready` is final and goes to the history as
`{ "id", "kind", "site", "agent", "status", "at" }`. The history keeps the last 200.

Two sites are the same site when the hosts are equal after dropping a leading `www.`, or one is a
subdomain of the other. This is the rule `box-type` uses.

## Agent API (Unix socket)

JSON in and out. Errors are `{ "error": "<code>", "detail": "<plain sentence>" }`.

**`POST /agent/requests`** `{ "kind", "site", "agent"?, "note"?, "viewerUrl"? }`

Returns `{ "request": Request }`: 201 for a new one, 200 when a `pending` or `ready` request of the
same kind and site exists, which is returned as it is with no second notification. Before making a
new request the broker checks, and fails without notifying anyone:

- 409 `no_device`: no phone is paired.
- 503 `box_unreachable`: `http://127.0.0.1:$BOX_CDP_PORT/json/list` doesn't answer.
- 422 `no_page`: no page in the box is on that site. The agent must open the sign-in page first.
- 422 `invalid`: a bad kind, site, note or viewerUrl.

A new request sends a push notification to every paired phone that has notifications on.

**`GET /agent/requests/<id>?wait=<seconds>`** returns `{ "request": Request }` as soon as the status
is not `pending`, or after `wait` seconds (0 to 300, default 0). 404 `not_found` for an unknown id.

**`POST /agent/requests/<id>/cancel`** returns `{ "request": Request }`. Only a `pending` or `ready`
request changes.

**`POST /agent/type`** `{ "site", "field": "username" | "password" | "code", "enter"?: boolean, "page"?: string, "keyboard"?: boolean }`

Types the held value for that site into the field the agent focused. Returns
`{ "exit": <number>, "message": "<what box-type printed>" }` with the exit code of the typing
command: 0 typed, 3 no focused field of that kind, 4 more than one page qualifies, 5 the field is
on another site, 1 anything else. 404 `nothing_held` when no value of that field is held for the
site. `enter` defaults to true for `password` and `code`, and is ignored for `username`.

**`GET /agent/status`** returns
`{ "version", "port", "devices": [{ "id", "name", "push": boolean, "lastSeenAt" }], "pending": <number> }`.

**`POST /agent/pair`** returns `{ "code", "expiresAt" }`. The code is 8 characters from
`ABCDEFGHJKLMNPQRSTUVWXYZ23456789`, valid for 10 minutes and for one pairing. A new code replaces
the old one.

**`POST /agent/unpair`** `{ "deviceId" }` or `{ "all": true }` returns `{ "removed": <number> }`.

**`POST /agent/push-test`** returns `{ "sent": <number>, "failed": <number> }`.

## Phone API (TCP)

JSON in and out, same error shape. Every `/api/*` request except `POST /api/pair` needs
`Authorization: Bearer <token>`, else 401 `unauthorized`. Every POST needs
`Content-Type: application/json`, a body of at most 16 KB, and, when it has an `Origin` header, an
origin whose host equals the `Host` header, else 403 `forbidden`.

**`POST /api/pair`** `{ "code", "name" }` returns `{ "deviceId", "token" }`. The code is compared
without regard to case or spaces. 403 `bad_code` for a wrong or expired code. After 5 wrong tries
the current code stops working, and the endpoint answers 429 `too_many_tries` until a new code is
made. `name` is at most 40 characters. The token is 32 random bytes in base64url. The broker stores
only its SHA-256 and compares in constant time.

**`GET /api/state?since=<rev>&wait=<seconds>`**

```json
{
  "rev": 42,
  "version": "1.5.0",
  "device": { "id": "d_p4q8", "name": "iPhone" },
  "push": { "publicKey": "<base64url P-256 point>", "subscribed": true },
  "requests": [],
  "history": []
}
```

`requests` holds the `pending` requests, oldest first. `history` holds the newest 30, newest first.
`rev` grows by one with every change. With `since` and `wait` (0 to 25), the call returns when
`rev` is greater than `since`, or after `wait` seconds. With neither it returns at once.

**`POST /api/requests/<id>/answer`**, body by kind:

- `credentials`: `{ "username", "password" }`. The password must not be empty. The username may be.
- `code`: `{ "code" }`, not empty.
- `handoff`: `{}`.

Each value is at most 1024 characters. Returns `{ "ok": true }`. 404 `not_found`, 409 `not_pending`,
422 `invalid`.

**`POST /api/requests/<id>/deny`** `{}` returns `{ "ok": true }`. Same errors.

**`POST /api/push/subscribe`** `{ "subscription": <PushSubscription.toJSON()> }` returns
`{ "ok": true }`. The endpoint must be `https` on a known push service: `*.push.apple.com`,
`fcm.googleapis.com`, `*.push.services.mozilla.com`, `*.notify.windows.com`, plus the hosts in
`BOX_BROKER_PUSH_HOSTS` (comma separated, for tests; `http` is allowed for those). Else 422
`invalid`. The broker keeps the request's origin with the subscription, for notification links.

**`POST /api/push/unsubscribe`** `{}` and **`POST /api/push/test`** `{}` return `{ "ok": true }`.
The test answers 502 `push_failed` with the push service's status in `detail` when it fails.

**`POST /api/unpair`** `{}` removes this phone and returns `{ "ok": true }`.

Static files: `GET /` is `index.html`, and `GET /<name>` serves the files of `app/` listed under
"Parts", nothing else. Every response carries `Cache-Control: no-cache`,
`X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` and, for HTML,
`Content-Security-Policy: default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`.
So the app has no inline scripts or styles and loads nothing from other sites.

## Push notifications

Web Push with VAPID (RFC 8292) and `aes128gcm` payloads (RFC 8291), written with `node:crypto`.
The VAPID `sub` is `https://github.com/kdpa-llc/agent-box`. Headers: `TTL` is the seconds until the
request expires, `Urgency: high`. A 404 or 410 from the push service removes that subscription.

The payload is declarative Web Push JSON, which Safari can show even without the service worker,
and which `sw.js` reads on other browsers:

```json
{
  "web_push": 8030,
  "notification": {
    "title": "Sign-in request",
    "body": "Claude wants to sign in to github.com",
    "tag": "r_k3v9x2m8",
    "navigate": "https://mac.example.ts.net:8444/#/r/r_k3v9x2m8"
  }
}
```

| Kind          | Title           | Body                                              |
| ------------- | --------------- | ------------------------------------------------- |
| `credentials` | Sign-in request | `<agent, or "An agent"> wants to sign in to <site>` |
| `code`        | Code needed     | `<site> is asking for a code`                     |
| `handoff`     | Your turn       | `<site>: <note>`                                  |
| test          | Agent Box       | `Notifications work.`                             |

`navigate` is the subscription's stored origin plus `/#/r/<id>` (`/` for the test). A notification
never contains a value.

## Typing

The broker runs `$BOX_BROKER_TYPE_CMD` (default: the `agent-box` next to it) as

```
agent-box type-stdin --kind <username|password|totp> --url <site> [--enter] [--clear-after 3] [--page <text>] [--keyboard]
```

with the value on stdin. `type-stdin` is a command of `agent-box` that pipes stdin to `box-type` in
the box, exactly as `type-secret --from-file` does today, and exits with `box-type`'s code. Field
`code` is kind `totp`. A password with `enter` gets `--enter --clear-after 3`; a code with `enter`
gets `--enter`.

## Commands

For agents:

```
agent-box login <site> [--as <label>] [--wait <seconds>]
agent-box login <site> --username [--page <text>]
agent-box login <site> --password [--no-enter] [--page <text>] [--keyboard]
agent-box login <site> --code [--no-enter] [--as <label>] [--wait <seconds>] [--page <text>]
agent-box login <site> --human "<what to do>" [--as <label>] [--wait <seconds>]
agent-box login <site> --cancel
```

- `login <site>` asks for a username and password and waits. It exits 0 once they are held, and
  says what to run next. Run again while they are held, it exits 0 at once.
- `--username` and `--password` type the held value into the field the agent clicked.
- `--code` asks for a code, waits, and types it into the focused code field. If the typing fails
  (exit 3, 4 or 5), the code stays held for its 120 seconds, and the same command types it again.
- `--human` asks the user to do a step in the live view, and exits 0 when they tap Done.
- `--wait` is how long one call waits (default 100 seconds, at most 300). The request itself lives
  for 30 minutes, and the same command picks it up again.
- `--as`, or `$AGENT_BOX_AS`, is the label the app shows.
- A new request keeps the box awake for its 30 minutes. It never shortens a longer hold.

Exit codes:

| Code | Meaning                                                                         |
| ---- | ------------------------------------------------------------------------------- |
| 0    | Done: values are held, a value was typed, or the user tapped Done               |
| 2    | Wrong usage                                                                     |
| 3    | No focused field of the right kind; nothing typed                               |
| 4    | More than one page qualifies; add `--page`                                      |
| 5    | No page on that site in the box, or the focused field is on another site        |
| 6    | The user denied it                                                              |
| 7    | The request expired or was cancelled, or nothing is held for that site          |
| 8    | The broker isn't running, or no phone is paired; use another way to sign in     |
| 75   | Still waiting for the user; run the same command again                          |

For the user:

```
agent-box broker on        install and start the service (macOS: a launch agent)
agent-box broker off       stop and remove it
agent-box broker status    whether it runs, paired phones, the phone address
agent-box broker pair      print a pairing code and the phone address
agent-box broker unpair <device id>|--all
agent-box broker test      send a test notification
agent-box broker run       run in the foreground (what the service runs)
```

## The phone app

One page, three views. It works at 320 pt wide and up, in light and dark, with the iPhone's safe
areas, and as a Home Screen app (`display: standalone`).

- **Pair**, when there is no token: a field for the 8-character code and a field for the phone's
  name. In a browser tab on an iPhone it first says how to add the app to the Home Screen, because
  notifications only work there and a Home Screen app has its own storage.
- **Requests**, the home view: one card per pending request, then the history. With nothing
  pending it says so.
  - `credentials`: the site in large type, the page's title and address, the agent's label, a
    username field (`autocomplete="username"`) and a password field
    (`autocomplete="current-password"`) so the keyboard offers the password manager, then Send and
    Deny. It says the login is used once and not saved.
  - `code`: one field (`autocomplete="one-time-code"`, `inputmode="numeric"`), Send and Deny.
  - `handoff`: the note, Open live view (when `viewerUrl` is set), Done and Can't.
  - Each card shows when it expires. A notification opens `/#/r/<id>`, which brings that card
    into view.
- **Settings**: notifications (turn on, send a test), the phone's name, Unpair, the version.

The app keeps its token in `localStorage` under `agentbox.token`. It keeps no value anywhere: it
clears a form as soon as it is sent, and never puts a value in an address or in storage. It follows
changes with `GET /api/state?since=<rev>&wait=25` in a loop, and reloads the state when it comes to
the front. A 401 drops the token and shows Pair.

`sw.js` handles `push` (shows `notification.title`, `body` and `tag`, with `navigate` as its link)
and `notificationclick` (focuses the app and goes to the link, or opens it). It caches nothing.

## What this does not protect against

- A program running as the same user can create requests, and can read a password field in the box
  in the moment after it is filled. The app shows the page the broker saw, and `box-type` types
  only on that site and empties the field 3 seconds after a password.
- Anyone with a paired phone can answer requests. Pairing needs a code that only a program on the
  machine can make.
