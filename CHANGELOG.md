# Changelog

All notable changes to this project will be documented in this file. See [Conventional Commits](https://conventionalcommits.org) for commit guidelines.

## [1.0.1](https://github.com/kdpa-llc/agent-box/compare/v1.0.0...v1.0.1) (2026-11-08)

### Bug Fixes

* **skill:** get sign-ins approved from the user's phone, not the viewer ([#3](https://github.com/kdpa-llc/agent-box/issues/3)) ([cce5102](https://github.com/kdpa-llc/agent-box/commit/cce5102248353dad51f07f26661bbd9534e06831))

## 1.0.0 (2026-11-07)

### Bug Fixes

* **door:** find the front door service by the script it runs ([ab05826](https://github.com/kdpa-llc/agent-box/commit/ab058266be4830eabea544586d5ad1a1d5136b0e))
* **podman:** build the seccomp profile from Docker's current default ([afed434](https://github.com/kdpa-llc/agent-box/commit/afed434f3e0e1c15d6eb34c8a24972f992f7db59))

### Documentation

* install from npm, and describe releases ([c051b55](https://github.com/kdpa-llc/agent-box/commit/c051b55c1224ca9c67566cefe5324feb00a3d407))
* README and community files in the KDPA layout ([69971f0](https://github.com/kdpa-llc/agent-box/commit/69971f077a71c1a7f10fffb6a406994e0abbca0c))
* show the screenshot on npm too ([3698904](https://github.com/kdpa-llc/agent-box/commit/369890430aa9505d95a9d420a0f488a36ce6195b))
* the first npm release is 1.0.0 ([37f78c8](https://github.com/kdpa-llc/agent-box/commit/37f78c8b9a514801c89c1aada1f575a1b1fe6968))

### Build System

* publish to npm as kdpa-agent-box ([1f4b365](https://github.com/kdpa-llc/agent-box/commit/1f4b365dbad08947f344929aeeb8005c1912a4c8))
* release to npm with semantic-release ([d2fd008](https://github.com/kdpa-llc/agent-box/commit/d2fd00834fa1ea30be8a260bc807437d7a987eff))

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
