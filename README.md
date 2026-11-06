# agent-box

A shared Linux desktop with Chromium and a password vault, for the AI agents on your Mac (Claude Code, Codex and others). Agents drive the browser with `playwright-cli`, and you can watch and take over from your phone. It runs only while it's used.

It uses the same recipe as Anthropic's computer-use demo and E2B's desktop template: a virtual screen (Xvfb), a light window manager (Openbox), VNC with a web viewer (noVNC), Chromium and xdotool. Chromium's remote-control port (CDP) is open on the Mac, so agents can use Playwright instead of clicking on pixels.

## Install

It needs a Mac with Apple silicon and macOS 26 or later, with Homebrew and Node.

**Through your agent:** open a session in your coding agent (Claude Code, Codex, T3 Code or similar) and paste this line:

```text
Install agent-box from https://github.com/kdpa-llc/agent-box by following the Install section of its README.
```

The agent does the install and asks you where to add its skill.

**By hand:** run these two commands in a terminal. `setup` asks you the same question. npm 12 refuses installs from GitHub unless you pass `--allow-git=root`, which allows only this package.

```sh
npm install -g --allow-git=root github:kdpa-llc/agent-box
agent-box setup
```

> **Agents doing the install:**
> 1. Check the Mac meets the requirements above. If it doesn't, tell the user and stop.
> 2. Ask the user where to add the `agent-box` skill; it's how agents learn to use the box. The defaults are the Claude Code skills folder (`$CLAUDE_CONFIG_DIR/skills`, or `~/.claude/skills` when that's unset) and `~/.agents/skills`, which Codex and other agents read. They may instead name other folders, or say none.
> 3. Run `npm install -g --allow-git=root github:kdpa-llc/agent-box`. Then run `agent-box setup` with `--skills-dir <folder>` once for each folder they named, `--no-skills` for none, or no option for the defaults. The first setup takes about 3 minutes.
> 4. Tell the user what setup printed, and that new agent sessions will know the box.

`agent-box setup` is safe to run again. It:

- installs Apple's `container` tool (Homebrew) and `playwright-cli` (npm) if they're missing;
- starts the container service, downloading its Linux kernel the first time;
- builds the box image, which takes about 3 minutes and 1.6 GB;
- links the `agent-box` skill into the chosen folders.

New agent sessions then know the box: the skill tells them when and how to use it. Sessions that were already open don't see it.

**Update:** run the same two commands again, by hand or through an agent. The skill is a link into the package, so it updates too, and the next `agent-box up` rebuilds the image if its files changed. Logins and passwords stay.

## For agents

The instructions are in the skill, [skills/agent-box/SKILL.md](skills/agent-box/SKILL.md). In short:

```sh
agent-box up                                 # start it (about 7 s); safe to run every time
playwright-cli -s=my-task attach --cdp=http://127.0.0.1:9222
playwright-cli -s=my-task tab-new https://example.com
playwright-cli -s=my-task snapshot
playwright-cli -s=my-task detach             # leaves the browser running for others
agent-box type-secret "GitHub test"          # types a saved password into the focused field
```

## For you

- **Watch or take over on the Mac:** open http://127.0.0.1:6080/.
- **From your phone:** install Tailscale on the phone and the Mac, signed in to the same account. Then run this once on the Mac. It makes the viewer reachable from your own devices only, not from the internet:

  ```sh
  /Applications/Tailscale.app/Contents/MacOS/Tailscale serve --bg --https=8443 http://127.0.0.1:6080
  ```

  `agent-box url` prints the phone address. Turn the phone sideways for a bigger view; the keyboard button is in the side bar.
- **Open the viewer when the box is off:** run `agent-box door on` once. It adds a 15 MB login service on port 6080 that starts the box when the address is opened, and shows a "Starting…" page meanwhile. The box's own viewer moves to port 6090. Without it, the address only works while the box runs. `agent-box door off` removes it.
- **Log in once by hand:** in the viewer, log in to the accounts the agents should use. The cookies stay in the box's storage.

### Passwords

- **The password manager:** KeePassXC, free and open source, inside the box. The vault is one encrypted file (AES-256, Argon2) in the box's storage, at `/data/vault/vault.kdbx`. Nothing is stored on the Mac or in a cloud.
- **Edit entries:** in the viewer, tap the key button at the bottom left. The manager opens unlocked. Add, edit or delete entries there, including 2FA codes (Entries > TOTP > Set up TOTP). It saves after every change.
- **Add one through an agent:** ask it to "save a password for X in the agent box". In T3 Code it shows you a private card for the password; elsewhere it asks you to add it in the viewer.
- **How agents use them:** `agent-box type-secret` looks up and types the entry inside the box, so the value doesn't appear in their chat, commands or output.
- **Chromium's own "Save password?" is off**, so the vault is the only place passwords live.
- **Unlocking:** the vault opens with a random master password kept next to it, in `/data/vault/.master`. That's what lets agents log in while you're away. It also means anything that can read the box's files can open the vault.
- **The limit:** the vault is encrypted on disk, but it isn't a wall against agents. They control the box, so one that goes digging could open the vault, or read a field it just filled. Keep only test or low-risk accounts there; never your email, bank or cloud admin accounts.

## Commands

`agent-box up`, `down`, `status`, `url`, `shot`, `x`, `exec`, `logs`, `build`, `off`, `door`, `secret`, `type-secret`, `setup`, `uninstall`. Run `agent-box help` for details.

Settings (environment variables for `agent-box up`):

| Variable | Default |
|---|---|
| `BOX_IDLE_MINUTES` | 20 (0 means never stop by itself) |
| `BOX_MEMORY` | 2G |
| `BOX_CPUS` | 2 |
| `BOX_WIDTH` × `BOX_HEIGHT` | 1280×800 |

## What it costs (measured on an Apple silicon Mac)

**Memory**
- About 0.9 GB inside the box with one page open. The VM holds about 1.7 GB on the Mac while it runs, and nothing once it stops.
- When the box is stopped, the container service stays at about 90 MB. `agent-box off` stops that too.

**Start and stop**
- Start: about 7 s. Stop: under 1 s.
- Idle stop: after `BOX_IDLE_MINUTES` with no viewer connected and no browser-control traffic. An idle Playwright connection doesn't keep it alive.

**Disk**
- About 2.2 GB in total while stopped: the 1.6 GB image, the VM kernel and the browser profile.
- Browser profile and vault: a 4 GB storage volume, mostly empty.
- A running box adds a 1.4 GB copy, deleted when it stops.
- Building the image temporarily needs about 4.5 GB of build cache, deleted afterwards.

## Files

- `agent-box`: the command.
- `skills/agent-box/SKILL.md`: the agent instructions that `setup` links into each agent.
- `Containerfile`: the image (Debian trixie-slim).
- `entrypoint.sh`: starts the screen, viewer, Chromium and the idle watchdog.
- `box-quit-browser`: closes Chromium cleanly so logins are saved; a plain stop signal kills it before it saves.
- `box-vault`: the password vault inside the box (KeePassXC). `desktop/` holds the taskbar and KeePassXC settings.
- `box-door.py`, `agent-box-door.plist`: the optional front door (`agent-box door on`).

Built on Apple's [container](https://github.com/apple/container) (Apache-2.0), where each box is a lightweight VM and nothing runs while it's stopped, and Microsoft's [playwright-cli](https://github.com/microsoft/playwright-cli) for browser control.

## Remove

```sh
agent-box uninstall          # skill links, front door, running box; keeps logins and passwords
agent-box uninstall --all    # also deletes the image and the box's storage, with its logins and passwords
npm rm -g @kdpa-llc/agent-box
brew uninstall container     # if nothing else uses it
```

Turn off the phone viewer with `tailscale serve --https=8443 off`.
