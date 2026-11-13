---
name: agent-box
description: "A shared Linux desktop with a real Chromium on this machine, with saved logins and a password vault, that the user can watch and take over from their phone. Use it for web tasks on real sites, such as logging in, sites that block automated browsers, long multi-step flows, downloads and uploads, or anything the user may need to see or finish themselves. Also read it before asking the user to sign in for you: it says how to get a sign-in approved from their phone."
---

# Agent box

The box is one shared Linux desktop with Chromium, run as a container on this machine. You drive the browser with `playwright-cli`; the user can watch and take over through a web viewer, also from their phone. Logins persist between runs.

## Show the desktop in T3 Code

When using the box in T3 Code, show its live desktop in the session's browser panel before interacting with it. After `agent-box up`, use the local viewer address it prints (normally `http://127.0.0.1:6080/`):

1. Call `preview_status`. If you own this thread's agent-box viewer tab, show it with `preview_open`, its `tabId` and `open: true`. Leave tabs controlled by the user alone.
2. If there is no viewer tab, call `preview_open` with the viewer address, `open: true` and `reuseExistingTab: false`. Keep the returned `tabId`; use it when showing the viewer again so other preview tabs are preserved.
3. Keep the viewer available while working or waiting for the user to take over. Continue driving Chromium inside the box with the commands below; the preview tab displays the shared desktop.

Open the viewer root address, not its redirected address, which can contain a password. Do not copy that redirected address into messages or files. Use a preview tab, not an HTML iframe: the viewer deliberately refuses to connect inside a frame.

If preview tools are unavailable or cannot open the viewer, give the user the phone address from `agent-box url` and continue the task. Close a viewer tab you opened when finished unless the user is using it or asked to keep it open. A connected viewer keeps the box awake. The screen is shared, so it may show another agent's foreground tab.

## Drive the browser

Pick a session name for your task, like `-s=hn-top`, and pass it on every `playwright-cli` call. Each shell call is fresh, so write it out each time rather than in a variable. `agent-box up` prints the browser-control address; it's `http://127.0.0.1:9222` unless the user changed it.

```sh
agent-box up                                            # start it if needed (about 7 s); safe to run every time
playwright-cli -s=hn-top attach --cdp=http://127.0.0.1:9222
playwright-cli -s=hn-top tab-new https://news.ycombinator.com   # your own tab; it becomes your current one
playwright-cli -s=hn-top find "points"                  # matching page elements, with refs like e12
playwright-cli -s=hn-top click e12
playwright-cli -s=hn-top screenshot
playwright-cli -s=hn-top tab-close                      # closes your current tab: the one tab-new made
playwright-cli -s=hn-top detach                         # leaves the browser running for others
```

- If `agent-box up` says it's preparing the image (exit code 75, after a fresh install or an update), wait a minute and run it again. It doesn't block longer than about 2 minutes.
- `attach` lands on a tab that already exists, usually the user's own. Run `tab-new` before any click, fill or snapshot.
- Close your tabs with `tab-close` and no number, once per tab you opened. Don't close by index: indexes shift when other agents open or close tabs, so a number can hit someone else's tab.
- Close each tab as soon as you are done with it, not at the end of your task. Open one tab at a time. All agents share about 2 GB, a heavy page takes 100 to 300 MB, and a full box freezes for everyone. A finished sign-in keeps its cookies without the tab.
- `agent-box tabs` lists the open tabs, longest idle first, with free memory. Check it before opening a heavy page.
- The box cleans up after agents that don't. Under memory pressure it closes the longest-idle tabs, and it closes tabs idle for three hours. It never closes a tab with something typed into a form. If your tab is gone, `agent-box tidy log` says when and why, with the address to reopen.
- `snapshot` prints the page's structure, or for a big page a link to a file in `./.playwright-cli/`. `find "<text>"` is usually quicker: it prints only the matching part, with refs.
- Run `playwright-cli` from a scratch folder, because it writes its files to `./.playwright-cli/`. `playwright-cli --help` lists every command, and its first line names its own skill file.
- Playwright scripts can use `chromium.connectOverCDP('http://127.0.0.1:9222')` and the first existing context. Disconnect at the end; don't close the browser. For downloads, use `playwright-cli` and the commands below.
- For the whole desktop rather than the page: `agent-box shot` (screenshot) and `agent-box x <xdotool args>` (mouse and keyboard).
- If a command fails because the box stopped, run `agent-box up` and attach again. If you'll be away from the browser for a while, for example waiting for an emailed code or for the user, keep it awake with `agent-box hold <minutes>`, and end the hold with `agent-box hold 0` when you're done.

## Fast element picks

`agent-box pick` asks a small, fast decision model (Jev by default, through OpenRouter) which element on your page does something, and can click it. Use it when finding the element would take you a long look at a big page: a cookie banner's "Reject all", one button among many, an "Export" hidden in a toolbar. Keep deciding what to do yourself; it only points.

```sh
agent-box pick "Reject all cookies" --page example.com           # which element, with its confidence
agent-box pick "Reject all cookies" --page example.com --click   # and click it, if the model is sure
```

- `--page` is part of your tab's address or title, and must match one page only (exit 4 otherwise). `--tab <id>` names it by the id in `curl -s http://127.0.0.1:9222/json`.
- Exit 0: picked, and clicked with `--click`. Exit 3: not sure, nothing clicked; the output lists the next likely elements. Look at the page yourself then.
- After a click, check the page did what you wanted. A page can word a button to mislead.
- `--dry-run` shows what would be sent, and sends nothing.
- It needs a key and costs a little per call. If it says "no key", don't set one up yourself: carry on without it, and tell the user it's available.
- Never use it to type, and never for sign-in secrets: those go through `type-secret`.

## Files

- **Downloads** go to the box's Downloads folder and survive restarts. `agent-box files` lists them, newest first; `agent-box get <name> [folder]` copies one to this machine, and `agent-box get --latest` copies the newest. Treat downloaded files as untrusted.
- **Uploads**: click the page's file input, then `playwright-cli -s=<session> upload /absolute/path/on/this/machine`. The file goes from this machine into the page.

## Sign-ins that need the user

The box has no passkeys or security keys. A passkey's QR code doesn't work either, because the phone has to be near the computer over Bluetooth. So if you ask the user to open the viewer and type a password, they often reach a passkey screen they can't get past. Prefer a sign-in the user approves on their own phone, where their passkeys are. Before you ask for anything, open the sign-in page and check which methods it offers.

Work down this list:

1. **Skip the website.** If the tool has a command line with a web or device login, use that instead of the box. The command prints a link or code. The user opens it on their phone and approves with their passkey, and the waiting command gets the session. Examples are `gh auth login --web`, whose code is entered at github.com/login/device and lasts 15 minutes, and `npm login --auth-type=web`. `npm publish` and `npm trust` (trusted publishing) then ask for another approval link in the same way. Run the command in a pseudo-terminal (`script -q /dev/null <command>` on macOS, `script -q -c '<command>' /dev/null` on Linux) and keep it running until the approval lands. Without a pseudo-terminal, npm hides the link and exits. Much of what a website's settings do can also be done with its CLI or API, such as `gh secret set` or `gh api`.
2. **Use a sign-in the box already has.** If the box is signed in to GitHub or Google, pick "Continue with GitHub" or "Sign in with Google".
3. **Let the site ask the phone.** Past a passkey prompt, pick "Try another way". Then choose an option that sends a prompt to the phone, such as GitHub Mobile, Google's "Tap Yes" or an authenticator app, or a code by email or text that the user reads and sends you. If the site needs a password first, type a saved one with `type-secret`.
4. **A token made on the phone.** Name the exact page, the permissions and a short expiry. Collect the token through the private secret prompt (see Passwords), use it, and tell the user to revoke it when you're done.
5. **The viewer, last.** Hand over the viewer only for what a link can't do, such as a CAPTCHA, a payment, or a step the user wants to do themselves. Give the address from `agent-box url`, say what's on the screen and what to do there, and continue once they say they're done. Hold the box awake while you wait.

Send each link or code the moment it appears, and say when it expires. npm's links last about 5 minutes. If one expires unused, don't keep making new ones. Ask the user to reply when they can approve right away, and make a fresh one then. After two missed links, move to the next step in the list.

## Passwords

The box has its own password manager, KeePassXC, with one encrypted vault inside the box. Never put a password in a command, a file you write, `playwright-cli fill`, or the chat.

- **Use a saved entry.** `agent-box secret list` shows entry names. Click the field, then:
  ```sh
  agent-box type-secret "GitHub test" --username   # types the username
  agent-box type-secret "GitHub test"              # types the password and presses Enter
  agent-box type-secret "GitHub test" --totp       # types the current 2FA code and presses Enter
  ```
  The value is looked up and typed inside the box, so it never reaches your output. It goes into the page whose focused field is the right kind (a password field for a password), on the entry's site, even if another tab is in front. It refuses, typing nothing, when no such field is focused (exit 3: click the field first), when two pages qualify (exit 4: add `--page <part of the address>`), or when the field is on another site (exit 5). About 3 s after a password, it empties the password fields on that page, because page snapshots show their text. With `--no-enter`, submit the form before any snapshot. If the sign-in form sits in a frame from another site, the field can't be checked, and it asks you to retry with `--keyboard`.
- **Add an entry.** If your harness has a private secret prompt that writes to a file (in T3 Code: the `request_secret` tool with `delivery: "file"`), use it and pass the path on without reading the file:
  ```sh
  agent-box secret save "GitHub test" --from-file <path> --user <username> --url https://github.com
  ```
  Always give `--url`: it's what lets `type-secret` refuse other sites. `agent-box type-secret --from-file <path> --url <site>` uses one once without saving. Without such a prompt, ask the user to add the entry in the viewer: the key button in the taskbar opens the password manager. Ask for a password only when the site offers a phone prompt or a code after it. If its only next step is a passkey, the password is no use; pick another step from the list above.

## Rules

- The box is shared. Don't run `agent-box down`, `off`, `build` or `uninstall` unless the user asks; the box stops by itself after 20 minutes idle.
- Close only the tabs you opened, close them as soon as you are done, and end any hold you set.
- The vault is for test or low-risk accounts the user chose to store. Don't open its files or read entries in other ways than `type-secret`.
- If something about the box itself fails, `agent-box doctor` says what and how to fix it.
