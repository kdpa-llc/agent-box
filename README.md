# agent-box

A shared Linux desktop with Chromium and a password vault, for the AI agents on your Mac or Linux machine (Claude Code, Codex and others). Agents drive the browser with `playwright-cli`, and you can watch and take over from your phone. It runs only while it's used.

It uses the same recipe as Anthropic's computer-use demo and E2B's desktop template: a virtual screen (Xvfb), a light window manager (Openbox), VNC with a web viewer (noVNC), Chromium and xdotool. Chromium's remote-control port (CDP) is open on the machine, so agents can use Playwright instead of clicking on pixels.

## Install

It needs Node, and one of these to run the box:

| Container tool | Runs on | Cost | Notes |
|---|---|---|---|
| Apple's `container` | Macs with Apple silicon and macOS 26 or later | Free, open source | The default there. Each box is its own small VM, and all its memory comes back when it stops. Setup installs it with Homebrew. |
| Colima with Docker | Macs, Linux | Free, open source | `brew install colima docker`, then `colima start`. Its VM stays on after the box stops, until `agent-box off` (which leaves it on if other containers use it). |
| Docker Desktop or OrbStack | Macs | Paid for some businesses | Docker Desktop is paid for companies with 250 or more people or $10M or more in revenue, and OrbStack is paid for commercial use. Like Colima, the VM stays on. |
| Docker Engine or Podman | Linux | Free, open source | No VM at all: the box is a plain container. Good for an always-on Linux server. Podman, and running on a Linux machine itself, aren't tested yet. |

**Through your agent:** open a session in your coding agent (Claude Code, Codex, T3 Code or similar) and paste this line:

```text
Install agent-box from https://github.com/kdpa-llc/agent-box by following the Install section of its README.
```

The agent does the install and asks you which container tool to use, if you have more than one, and where to add its skill.

**By hand:** run these two commands in a terminal. `setup` asks you the same questions. npm 12 refuses installs from GitHub unless you pass `--allow-git=root`, which allows only this package.

```sh
npm install -g --allow-git=root github:kdpa-llc/agent-box
agent-box setup
```

> **Agents doing the install:**
> 1. Check the machine has Node and can run one of the container tools above: `uname -sm`, `sw_vers` on a Mac, and `command -v container docker podman`. If none fits, show the user the table and stop.
> 2. If more than one tool fits, ask the user which to use. Apple's `container` is the default on Macs that can run it; Docker or Podman must already be running.
> 3. Ask the user where to add the `agent-box` skill; it's how agents learn to use the box. The defaults are the Claude Code skills folder (`$CLAUDE_CONFIG_DIR/skills`, or `~/.claude/skills` when that's unset) and `~/.agents/skills`, which Codex and other agents read. They may instead name other folders, or say none.
> 4. Run `npm install -g --allow-git=root github:kdpa-llc/agent-box`. Then run `agent-box setup --runtime <tool>`, adding `--skills-dir <folder>` once for each folder they named, `--no-skills` for none, or nothing for the defaults. The first setup takes 1 to 3 minutes.
> 5. Tell the user what setup printed, and that new agent sessions will know the box.

`agent-box setup` is safe to run again. It:

- installs `playwright-cli` (npm) if it's missing, and Apple's `container` (Homebrew) when that's the chosen tool;
- starts the container tool, and remembers the choice in `~/.config/agent-box/config`;
- builds the box image, which takes 1 to 3 minutes and 1.7 GB;
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

- **Watch or take over on the same machine:** open http://127.0.0.1:6080/.
- **From your phone:** install Tailscale on the phone and the machine, signed in to the same account. Then run this once on the machine (on Linux, the command is just `tailscale`). It makes the viewer reachable from your own devices only, not from the internet:

  ```sh
  /Applications/Tailscale.app/Contents/MacOS/Tailscale serve --bg --https=8443 http://127.0.0.1:6080
  ```

  `agent-box url` prints the phone address. Turn the phone sideways for a bigger view; the keyboard button is in the side bar.
- **Open the viewer when the box is off (macOS):** run `agent-box door on` once. It adds a 15 MB login service on port 6080 that starts the box when the address is opened, and shows a "Starting…" page meanwhile. The box's own viewer moves to port 6090. Without it, the address only works while the box runs. `agent-box door off` removes it.
- **Log in once by hand:** in the viewer, log in to the accounts the agents should use. The cookies stay in the box's storage.

### Passwords

- **The password manager:** KeePassXC, free and open source, inside the box. The vault is one encrypted file (AES-256, Argon2) in the box's storage, at `/data/vault/vault.kdbx`. Nothing is stored outside the box or in a cloud.
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
| `BOX_CDP_PORT`, `BOX_VIEW_PORT` | 9222, 6080 |
| `BOX_RUNTIME` | the tool chosen in setup |

## What it costs (measured on an M4 Mac mini)

**Memory**
- About 0.9 GB inside the box with one page open.
- With Apple's `container`, the VM holds about 1.8 GB on the Mac while the box runs, and nothing once it stops. The container service stays at about 90 MB; `agent-box off` stops that too, unless other containers use it.
- With Colima, its VM held about 1.6 GB with the box running, and stays on until `agent-box off`.

**Start and stop**
- Start: about 7 s with Apple's `container`. With Colima, about 1 s while its VM is on, or 11 s with the VM off.
- Stop: under 1 s.
- Idle stop: after `BOX_IDLE_MINUTES` with no viewer connected and no browser-control traffic. An idle Playwright connection doesn't keep it alive.

**Disk**
- About 2.2 GB in total while stopped: the 1.7 GB image, the VM kernel and the browser profile.
- Browser profile and vault: a storage volume, mostly empty.
- With Apple's `container`, a running box adds a 1.4 GB copy, deleted when it stops, and building the image temporarily needs about 4.5 GB of build cache, deleted afterwards.

## Files

- `agent-box`: the command.
- `skills/agent-box/SKILL.md`: the agent instructions that `setup` links into each agent.
- `Containerfile`: the image (Debian trixie-slim).
- `entrypoint.sh`: starts the screen, viewer, Chromium and the idle watchdog.
- `box-quit-browser`: closes Chromium cleanly so logins are saved; a plain stop signal kills it before it saves.
- `box-vault`: the password vault inside the box (KeePassXC). `desktop/` holds the taskbar and KeePassXC settings.
- `box-door.py`, `agent-box-door.plist`: the optional front door (`agent-box door on`).
- `chromium-seccomp.json`: lets Chromium keep its own sandbox under Docker and Podman, whose default filter blocks it. It's [Playwright's seccomp profile](https://github.com/microsoft/playwright/blob/main/utils/docker/seccomp_profile.json) (Apache-2.0), unchanged: Docker's default plus `clone`, `setns` and `unshare`.

Built on Apple's [container](https://github.com/apple/container) (Apache-2.0), where each box is a lightweight VM and nothing runs while it's stopped, Docker or Podman as the alternative, and Microsoft's [playwright-cli](https://github.com/microsoft/playwright-cli) for browser control.

## Remove

```sh
agent-box uninstall          # skill links, front door, running box; keeps logins and passwords
agent-box uninstall --all    # also deletes the image and the box's storage, with its logins and passwords
npm rm -g @kdpa-llc/agent-box
brew uninstall container     # if you used it and nothing else does
```

Turn off the phone viewer with `tailscale serve --https=8443 off`.
