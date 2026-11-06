---
name: agent-box
description: A shared Linux desktop with a real Chromium on this Mac, with saved logins and a password vault, that the user can watch and take over from their phone. Use it for web tasks on real sites, such as logging in, sites that block automated browsers, long multi-step flows and downloads, or anything the user may need to see or finish themselves.
---

# Agent box

The box is one shared Linux desktop with Chromium, run as a small VM on this Mac. You drive the browser with `playwright-cli`; the user can watch and take over through a web viewer, also from their phone. Logins persist between runs.

## Drive the browser

Pick a session name for your task, like `-s=hn-top`, and pass it on every `playwright-cli` call. Each shell call is fresh, so write it out each time rather than in a variable.

```sh
agent-box up                                            # start it if needed (about 7 s); safe to run every time
playwright-cli -s=hn-top attach --cdp=http://127.0.0.1:9222
playwright-cli -s=hn-top tab-new https://news.ycombinator.com   # your own tab; it becomes your current one
playwright-cli -s=hn-top find "points"                  # matching page elements, with refs like e12
playwright-cli -s=hn-top click e12
playwright-cli -s=hn-top screenshot
playwright-cli -s=hn-top tab-list                       # find your tab's index...
playwright-cli -s=hn-top tab-close 1                    # ...and close only that one
playwright-cli -s=hn-top detach                         # leaves the browser running for others
```

- `attach` lands on a tab that already exists, usually the user's own. Run `tab-new` before any click, fill or snapshot.
- `snapshot` and most commands print a file path, not the page: read `./.playwright-cli/page-*.yml` with `grep` or `head`, or use `find "<text>"`, which prints the matching part of the page.
- Run `playwright-cli` from a scratch folder, because it writes those files to `./.playwright-cli/`. `playwright-cli --help` lists every command, and its first line names its own skill file.
- Tab indexes shift when other agents open or close tabs, so check `tab-list` right before `tab-close`.
- Scripts can use Playwright's `chromium.connectOverCDP('http://127.0.0.1:9222')` and the first existing context. Disconnect at the end; don't close the browser.
- For the whole desktop rather than the page: `agent-box shot` (screenshot) and `agent-box x <xdotool args>` (mouse and keyboard).
- If a command fails because the box stopped, run `agent-box up` and attach again.

## Hand over to the user

When a step needs a person (a CAPTCHA, a passkey, a login you shouldn't store, a payment), stop and tell the user the viewer address from `agent-box url`. Say what's on the screen and what they should do there. Continue once they say they're done.

## Passwords

The box has its own password manager, KeePassXC, with one encrypted vault inside the box. Never put a password in a command, a file you write, `playwright-cli fill`, or the chat.

- **Use a saved entry.** `agent-box secret list` shows entry names. Click the field, then:
  ```sh
  agent-box type-secret "GitHub test" --username   # types the username
  agent-box type-secret "GitHub test"              # types the password and presses Enter
  agent-box type-secret "GitHub test" --totp       # types the current 2FA code and presses Enter
  ```
  The value is looked up and typed inside the box, so it never reaches your output. About 3 s after a password, it clears any password still in a field, because page snapshots show the text of password fields. With `--no-enter`, submit the form before any snapshot.
- **Add an entry.** If your harness has a private secret prompt that writes to a file (in T3 Code: the `request_secret` tool with `delivery: "file"`), use it and pass the path on without reading the file:
  ```sh
  agent-box secret save "GitHub test" --from-file <path> --user <username> --url https://github.com
  ```
  `agent-box type-secret --from-file <path>` uses one once without saving. Without such a prompt, ask the user to add the entry in the viewer: the key button in the taskbar opens the password manager.

## Rules

- The box is shared. Don't run `agent-box down`, `off`, `build` or `uninstall` unless the user asks; the box stops by itself after 20 minutes idle.
- Close only the tabs you opened.
- The vault is for test or low-risk accounts the user chose to store. Don't open its files or read entries in other ways than `type-secret`.
