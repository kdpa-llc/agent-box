# Security Policy

## Supported Versions

We release patches for security vulnerabilities for the following versions:

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |
| < 0.1   | :x:                |

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

1. **Keep Updated**: Run `npm install -g agent-box` and `agent-box setup` now and then
2. **Store Low-Risk Accounts Only**: Use the vault for test or low-risk accounts, never for your email, bank or cloud admin accounts
3. **Keep the Ports Local**: The browser-control port and the viewer listen on 127.0.0.1 only. Don't forward or publish them
4. **Share the Viewer Privately**: Use Tailscale Serve, which reaches only your own devices, rather than a public tunnel. Never use Tailscale Funnel for the viewer
5. **Trust Your Agents**: Everything the box can reach, the agents driving it can reach too

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
- Page snapshots show the text of password fields. `type-secret` clears password fields about 3 seconds after typing a password, but an agent that reads a field before then, or one typed with `--no-enter`, sees the value
- The vault keeps passwords out of agents' context and logs. It isn't a wall against an agent that sets out to read them

### Browser Control and the Viewer

- Chromium's remote-control port (CDP) gives full control of the browser, including its cookies. It's published on 127.0.0.1 only, so any local process on the machine can use it
- The VNC viewer has no password and is published on 127.0.0.1 only. Anyone who can reach it can see and use the desktop
- Chromium's own password manager is turned off by policy, so passwords live only in the vault

### Isolation

- With Apple's `container`, each box is its own lightweight VM
- With Docker or Podman on Linux, the box is a container sharing the host's kernel. On macOS they run it inside their own Linux VM
- Chromium keeps its sandbox. Under Docker and Podman, the box uses [Playwright's seccomp profile](https://github.com/microsoft/playwright/blob/main/utils/docker/seccomp_profile.json), which is Docker's default plus the `clone`, `setns` and `unshare` calls the sandbox needs, instead of `--no-sandbox`
- The box runs Chromium as an unprivileged user (`agent`)

### The Front Door (macOS)

- `agent-box door on` installs a login service that listens on 127.0.0.1:6080 and starts the box when that address is opened

## Security Updates

Security updates will be:

- Released as patch versions (e.g., 0.1.1)
- Documented in CHANGELOG.md
- Announced in the release notes
- Tagged with [SECURITY] in commit messages

## Contact

For security concerns, please use GitHub's private vulnerability reporting on this repository.

Thank you for helping keep Agent Box secure!
