---
name: agent-box
description: A shared Linux desktop with a real Chromium on this machine, with saved logins and a password vault, that the user can watch and take over from their phone. Use it for web tasks on real sites, such as logging in, sites that block automated browsers, long multi-step flows and downloads, or anything the user may need to see or finish themselves. Also read it before asking the user to sign in for you: it says how to get a sign-in approved from their phone.
---

# Agent box

The box is one shared Linux desktop with Chromium, run as a container on this machine. You drive the browser with `playwright-cli`; the user can watch and take over through a web viewer, also from their phone. Logins persist between runs.

## Drive the browser

Pick a session name for your task, like `-s=hn-top`, and pass it on every `playwright-cli` call. Each shell call is fresh, so write it out each time rather than in a variable. `agent-box up` prints the browser-control address; it's `http://127.0.0.1:9222` unless the user changed it.

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

## Sign-ins that need the user

The box has no passkeys or security keys. A passkey's QR code doesn't work either, because the phone has to be near the computer over Bluetooth. So if you ask the user to open the viewer and type a password, they often reach a passkey screen they can't get past. Prefer a sign-in the user approves on their own phone, where their passkeys are. Before you ask for anything, open the sign-in page and check which methods it offers.

Work down this list:

1. **Skip the website.** If the tool has a command line with a web or device login, use that instead of the box. The command prints a link or code. The user opens it on their phone and approves with their passkey, and the waiting command gets the session. Examples are `gh auth login --web`, whose code is entered at github.com/login/device and lasts 15 minutes, and `npm login --auth-type=web`. `npm publish` and `npm trust` (trusted publishing) then ask for another approval link in the same way. Run the command in a pseudo-terminal (`script -q /dev/null <command>` on macOS) and keep it running until the approval lands. Without a pseudo-terminal, npm hides the link and exits. Much of what a website's settings do can also be done with its CLI or API, such as `gh secret set` or `gh api`.
2. **Use a sign-in the box already has.** If the box is signed in to GitHub or Google, pick "Continue with GitHub" or "Sign in with Google".
3. **Let the site ask the phone.** Past a passkey prompt, pick "Try another way". Then choose an option that sends a prompt to the phone, such as GitHub Mobile, Google's "Tap Yes" or an authenticator app, or a code by email or text that the user reads and sends you. If the site needs a password first, type a saved one with `type-secret`.
4. **A token made on the phone.** Name the exact page, the permissions and a short expiry. Collect the token through the private secret prompt (see Passwords), use it, and tell the user to revoke it when you're done.
5. **The viewer, last.** Hand over the viewer only for what a link can't do, such as a CAPTCHA, a payment, or a step the user wants to do themselves. Give the address from `agent-box url`, say what's on the screen and what to do there, and continue once they say they're done.

Send each link or code the moment it appears, and say when it expires. npm's links last about 5 minutes. If one expires unused, don't keep making new ones. Ask the user to reply when they can approve right away, and make a fresh one then. After two missed links, move to the next step in the list.

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
  `agent-box type-secret --from-file <path>` uses one once without saving. Without such a prompt, ask the user to add the entry in the viewer: the key button in the taskbar opens the password manager. Ask for a password only when the site offers a phone prompt or a code after it. If its only next step is a passkey, the password is no use; pick another step from the list above.

## Rules

- The box is shared. Don't run `agent-box down`, `off`, `build` or `uninstall` unless the user asks; the box stops by itself after 20 minutes idle.
- Close only the tabs you opened.
- The vault is for test or low-risk accounts the user chose to store. Don't open its files or read entries in other ways than `type-secret`.
