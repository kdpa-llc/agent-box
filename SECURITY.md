# Security Policy

## Supported Versions

We release patches for security vulnerabilities for the following versions:

| Version | Supported          |
| ------- | ------------------ |
| 1.x     | :white_check_mark: |
| < 1.0   | :x:                |

## Reporting a Vulnerability

We take the security of Agent Box seriously. If you discover a security vulnerability, please follow these steps:

### How to Report

**Please do NOT open a public issue.**

Instead, report it privately through GitHub: open the [Security tab](https://github.com/kdpa-llc/agent-box/security) and choose **Report a vulnerability**.

### What to Include

When reporting a vulnerability, please include:

- Description of the vulnerability
- Steps to reproduce the issue
- Potential impact
- Suggested fix (if you have one)
- Your container tool and OS

Never include real passwords, vault files or cookies in a report.

### Response Timeline

- **Acknowledgment**: We aim to acknowledge receipt within 48 hours
- **Initial Assessment**: We'll provide an initial assessment within 5 business days
- **Updates**: We'll keep you informed of our progress
- **Resolution**: We aim to release a fix as soon as possible, depending on complexity

### Disclosure Policy

- Please give us reasonable time to fix the issue before public disclosure
- We'll credit you in the security advisory (unless you prefer to remain anonymous)
- We'll coordinate with you on the disclosure timeline

## Security Best Practices

When using Agent Box:

### For Users

1. **Keep Updated**: Run `npm install -g kdpa-agent-box` and `agent-box setup` now and then
2. **Store Low-Risk Accounts Only**: Use the vault for test or low-risk accounts, never for your email, bank or cloud admin accounts
3. **Keep the Ports Local**: The browser-control port and the viewer listen on 127.0.0.1 only. Don't forward or publish them
4. **Share the Viewer Privately**: Use Tailscale Serve, which reaches only your tailnet (every device and person its access rules allow), rather than a public tunnel. Never use Tailscale Funnel for the viewer
5. **Trust Your Agents**: Everything the box can reach, the agents driving it can reach too
6. **Check the Site Before You Send a Login**: The phone app shows the page the box has open. Deny a request you didn't expect, or one for a site that doesn't match
7. **Unpair a Lost Phone**: Run `agent-box broker unpair --all`, then pair your phones again

### For Contributors

1. **No Secrets in Code**: Never commit passwords, tokens or vault files
2. **No Secrets on Command Lines**: Pass secrets on stdin or in files, never as arguments, which other processes and logs can see
3. **No Secrets in Output**: Commands must not print vault values
4. **Keep Chromium's Sandbox On**: Don't add `--no-sandbox`; fix the container settings instead

## Known Security Considerations

### The Password Vault

- The vault is a KeePassXC database (AES-256, Argon2) at `/data/vault/vault.kdbx` in the box's storage
- It unlocks with a random master password kept next to it, so agents can log in while you're away. Anything that can read the box's files can open the vault
- `agent-box type-secret` looks up and types an entry inside the box, so its value doesn't reach the agent's commands, output or chat
- It types over CDP into the one page whose focused field is the right kind (a password field for a password), on the site saved with the entry. It refuses, typing nothing, when the field is on another site, when no such field is focused, or when two pages qualify. So a password can't land in another agent's tab, a search box, or a look-alike site. Entries saved without a web address skip the site check
- Page snapshots show the text of password fields. `type-secret` empties the password fields on that page about 3 seconds after typing a password, but an agent that reads a field before then, or one typed with `--no-enter`, sees the value
- The vault keeps passwords out of agents' context and logs. It isn't a wall against an agent that sets out to read them

### Browser Control and the Viewer

- Chromium's remote-control port (CDP) gives full control of the browser, including its cookies. It's published on 127.0.0.1 only, so any local process on the machine can use it. Chromium refuses CDP connections from web pages
- The viewer is published on 127.0.0.1 only and has a VNC password (8 random characters, kept in the box's storage). The viewer's start page passes it on only when opened in its own tab, not inside another page's frame, so a web page open on the same machine can neither connect to the desktop nor show it to you in a frame. Programs on the machine itself can read the start page
- The box runs on its own container network (`agent-box`), so other containers can't reach its browser-control or viewer ports
- Chromium's own password manager is turned off by policy, so passwords live only in the vault

### Isolation

- With Apple's `container`, each box is its own lightweight VM
- With Docker or Podman on Linux, the box is a container sharing the host's kernel. On macOS they run it inside their own Linux VM
- Chromium keeps its sandbox. Under Docker and Podman, the box runs with [Docker's default seccomp profile](https://github.com/moby/profiles/blob/main/seccomp/default.json) plus the `clone`, `setns` and `unshare` calls the sandbox needs, instead of `--no-sandbox`. That's the same change [Playwright's profile](https://github.com/microsoft/playwright/blob/main/utils/docker/seccomp_profile.json) makes; `npm run update:seccomp` regenerates it
- The box runs Chromium as an unprivileged user (`agent`)
- The image is rebuilt with current Debian packages when it's over 14 days old (`BOX_REFRESH_DAYS`), and every `agent-box build` fetches current packages, so Chromium gets security updates

### The Front Door (macOS)

- `agent-box door on` installs a login service that listens on 127.0.0.1:6080 and starts the box when that address is opened. It starts the box only for a page someone opened (a navigation), not for a request a web page makes in the background

### The Login Broker

- `agent-box broker on` runs a small service on this machine. Agents talk to it over a Unix socket in its own folder (`~/.config/agent-box/broker`, mode 700; the socket is 600). The phone app is served on 127.0.0.1 only, and you publish it to your tailnet with Tailscale Serve. Never use Tailscale Funnel for it
- A phone pairs with a one-time code that only a program on the machine can make. Each phone gets its own random token, and the broker keeps only its hash. Pairing allows five wrong codes, then needs a new code
- Logins sent from the phone stay in the broker's memory only. They never go to disk, logs, notifications or the agent, and are zeroed when dropped. They are held for 5 minutes at most (a code for 2), and dropped once the password or code is typed
- The broker types a value only through `box-type`, so the same site and field checks as `type-secret` apply. The site is the one the request named, and the app shows the page the broker itself saw in the box, not what the agent said
- The phone API needs a JSON body of at most 16 KB, a matching `Origin`, and a paired phone's token. It serves only the app's own files
- Notifications go through Apple's or another browser's push service, encrypted, and never contain a value
- It doesn't protect against a program running as you: such a program can create requests, and can read a password field in the box in the moment after it's filled. Anyone with a paired phone can answer requests

## Security Updates

Security updates will be:

- Released as patch versions (e.g., 1.0.1)
- Documented in CHANGELOG.md
- Announced in the release notes
- Tagged with [SECURITY] in commit messages

## Contact

For security concerns, please use GitHub's private vulnerability reporting on this repository.

Thank you for helping keep Agent Box secure!
