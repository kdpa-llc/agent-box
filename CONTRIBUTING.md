# Contributing to Agent Box

Thank you for your interest in contributing to Agent Box! We welcome contributions from the community.

## How to Contribute

### Reporting Bugs

If you find a bug, please open an issue on GitHub with:

- A clear, descriptive title
- Steps to reproduce the issue
- Expected behavior
- Actual behavior
- Your environment: OS, container tool (`agent-box runtime`), agent, and `agent-box version`
- The output of `agent-box status` and the end of `agent-box logs`

Never paste passwords, vault entries or cookies into an issue.

### Suggesting Features

We welcome feature suggestions! Please open an issue with:

- A clear description of the feature
- The problem it solves
- Any examples or use cases
- Optional: proposed implementation approach

### Pull Requests

1. **Fork the repository** and create your branch from `main`
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. **Make your changes**
   - Write clear, concise commit messages
   - Follow the existing code style
   - Update the README, and the agent skill if agents use what you changed
   - Keep passwords out of command lines, logs and agent output

3. **Test your changes**
   ```bash
   npm run lint
   npm test
   ```

4. **Submit a pull request**
   - Provide a clear description of the changes
   - Reference any related issues
   - Say which container tools you tested with
   - Ensure CI checks pass

## Development Setup

```bash
# Clone your fork
git clone https://github.com/YOUR_USERNAME/agent-box.git
cd agent-box

# Install the dev tools and the commit-message hook
npm install

# Run the command straight from the checkout
./agent-box setup --skills-dir /tmp/agent-box-skills
./agent-box up
```

`./agent-box` from a checkout works like the installed command. To try changes without touching a box you use for real, run a second box with its own name, storage and ports:

```bash
BOX_NAME=agent-box-dev BOX_VOLUME=agent-box-dev-data BOX_CDP_PORT=9322 BOX_VIEW_PORT=6180 ./agent-box up
```

The image is tagged with a checksum of the files it's built from, so the next `up` rebuilds it after you change `Containerfile`, `entrypoint.sh`, `box-vault`, `box-quit-browser` or `desktop/`.

## Code Style

- Shell scripts are Bash (macOS ships Bash 3.2, so no Bash 4 features in `agent-box`) and pass `shellcheck -S warning`
- Scripts inside the box are POSIX `sh` unless they need more
- Follow existing patterns and conventions
- Keep functions focused and small
- Add comments for anything a reader would otherwise have to work out
- Write user-facing messages in plain words and say what to do next

## Commit Messages

This project uses [Conventional Commits](https://www.conventionalcommits.org/) for automated versioning and changelog generation. The `commit-msg` hook checks each message, and CI checks every commit in a pull request.

### Commit Format

```
<type>(<scope>): <subject>

<body>

<footer>
```

### Commit Types

- **feat**: A new feature (triggers minor version bump)
- **fix**: A bug fix (triggers patch version bump)
- **perf**: A performance improvement (triggers patch version bump)
- **docs**: Documentation changes (triggers patch version bump)
- **refactor**: Code refactoring without feature changes (triggers patch version bump)
- **build**: Changes to the image or packaging (triggers patch version bump)
- **style**: Code style changes (formatting, no functional changes)
- **test**: Adding or updating tests
- **ci**: Changes to CI configuration
- **chore**: Other changes
- **revert**: Reverts a previous commit (triggers patch version bump)

### Breaking Changes

For a change that breaks existing installs or agent instructions, add `BREAKING CHANGE:` in the commit body or append `!` after the type. This triggers a major version bump:

```
feat!: rename the type-secret command

BREAKING CHANGE: agents must call `agent-box fill` instead of `agent-box type-secret`
```

### Examples

```bash
# Feature
feat(vault): add TOTP codes to type-secret

# Bug fix
fix(docker): keep Chromium's sandbox under the default seccomp profile

# Documentation
docs(readme): explain the phone viewer

# Breaking change
feat!: move the config to ~/.config/agent-box/config.toml

BREAKING CHANGE: setup must be run again after updating
```

### Guidelines

- Use imperative mood ("Add feature" not "Added feature")
- Reference issues in the footer: `Resolves #123` or `Closes #456`
- Keep subject line under 72 characters
- Separate subject from body with a blank line
- Use body to explain what and why, not how

## Project Structure

```
agent-box/
├── agent-box                  # The command: setup, up, down, secrets, ...
├── skills/agent-box/SKILL.md  # What agents read to use the box
├── Containerfile              # The box image (Debian trixie-slim)
├── entrypoint.sh              # Starts the screen, viewer, Chromium and idle watchdog
├── box-vault                  # Password vault inside the box (KeePassXC)
├── box-type                   # Types a vault entry into the right page and field, over CDP
├── box-tidy                   # Lists tabs and closes idle ones, by age or when memory runs short
├── box-quit-browser           # Closes Chromium cleanly so logins are saved
├── desktop/                   # Taskbar and KeePassXC settings
├── chromium-seccomp.json      # Lets Chromium keep its sandbox under Docker and Podman
├── box-door.py                # Optional front door on macOS (agent-box door on)
├── agent-box-door.plist       # Its launchd template
├── tests/smoke.sh             # End-to-end test on a real box
├── scripts/                   # Release-notes check, seccomp profile generator
├── .releaserc.json            # semantic-release configuration
└── commitlint.config.js       # Commit message rules
```

## Testing

### Running Tests

```bash
# Lint the scripts (shellcheck)
npm run lint

# End-to-end test with the container tool chosen in setup
npm test

# Or with a specific one
BOX_RUNTIME=docker tests/smoke.sh
```

The smoke test starts its own box on other ports with its own storage. It checks the viewer needs its password, drives Chromium with `playwright-cli`, types vault entries into the right one of two tabs and checks the wrong site and the wrong kind of field are refused, downloads and uploads a file, checks the time zone and `hold`, restarts the box to check logins survived, and removes the box again.

### What CI Covers

CI runs the lint checks, checks that release notes can be generated and that commit messages follow Conventional Commits, then installs the package and runs the smoke test on Linux with Docker (x64 and arm64) and with Podman. GitHub's macOS runners can't run Apple's `container`, so test changes that affect it on a Mac with Apple silicon and say so in the pull request.

### Manual Testing

For changes to the desktop, the viewer or the password manager, open the viewer at http://127.0.0.1:6080/ and try it, ideally from a phone as well.

## Documentation

When adding features or changing functionality:

- Update README.md
- Update `skills/agent-box/SKILL.md` when agents use the change; keep it short, since agents load it into their context
- Update `agent-box help`
- Don't edit CHANGELOG.md by hand: semantic-release writes it from the commit messages

## Releases

Releases are automatic. After CI passes on `main`, semantic-release picks the next version from the commit messages, publishes it to npm, creates a GitHub release and updates CHANGELOG.md. See [PUBLISHING.md](PUBLISHING.md).

## Community

- Be respectful and inclusive
- Follow our [Code of Conduct](CODE_OF_CONDUCT.md)
- Help others in discussions and issues
- Share your use cases and setups!

## Questions?

Feel free to open an issue for questions or join the discussion in existing issues.

Thank you for contributing! 🎉
