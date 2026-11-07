# Changelog

All notable changes to this project will be documented in this file. See [Conventional Commits](https://conventionalcommits.org) for commit guidelines.

## 0.1.0 (2026-11-06)

First version, installed from GitHub before releases were published to npm.

### Features

* **box:** one shared Linux desktop (Xvfb, Openbox, tint2) with Chromium, viewable in a browser through noVNC
* **browser:** Chromium's remote-control port (CDP) on 127.0.0.1:9222, for `playwright-cli` and Playwright scripts
* **lifecycle:** `agent-box up` starts the box in seconds; it stops by itself after 20 idle minutes, and quits Chromium cleanly so logins are saved
* **vault:** KeePassXC password vault inside the box; `agent-box type-secret` types usernames, passwords and TOTP codes without printing them, then clears leftover password fields
* **vault:** `agent-box secret save` stores a password from a private secret prompt, such as T3 Code's `request_secret`
* **viewer:** a key button in the taskbar opens the password manager unlocked
* **phone:** viewer reachable from a phone over Tailscale Serve; `agent-box door on` (macOS) starts the box when the address is opened
* **runtimes:** Apple's `container`, Docker (Docker Desktop, OrbStack, Colima, Docker Engine) or Podman, chosen in `agent-box setup --runtime`
* **docker:** Chromium keeps its sandbox under Docker and Podman, with Docker's default seccomp profile plus the calls the sandbox needs
* **agents:** `agent-box setup` links an Agent Skill into Claude Code and `~/.agents/skills` (Codex and others), or folders you choose
* **install:** from GitHub, or by pasting one line into a coding agent
