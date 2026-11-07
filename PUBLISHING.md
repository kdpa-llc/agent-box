# Publishing Guide

This guide explains how Agent Box is released to npm as [`agent-box`](https://www.npmjs.com/package/agent-box).

## Prerequisites

1. **npm Account**: the package is published by the `moscaverd` npm account
2. **npm Credential**: an `NPM_TOKEN` Actions secret, or npm trusted publishing (see below)
3. **GitHub Credential**: a `RELEASE_TOKEN` Actions secret

## Automated Publishing (Recommended)

The project uses [semantic-release](https://github.com/semantic-release/semantic-release) for automated versioning and publishing.

### How It Works

1. **Commit with Conventional Commits**: Use the conventional commit format. The `commit-msg` hook (husky and commitlint, set up by `npm install`) checks it, and CI checks it on pull requests
   ```bash
   git commit -m "feat: add new feature"
   git commit -m "fix: resolve bug"
   ```

2. **Merge to main**: The `Release` workflow runs after the `CI` workflow passes on `main`
   ```bash
   git push origin main
   ```

3. **Automated Process**:
   - Analyzes commits to determine version bump
   - Generates CHANGELOG.md
   - Creates GitHub release
   - Publishes to npm
   - Commits the version and changelog back to `main`, marked `[skip ci]`

The Release workflow only runs after CI succeeds, so a version is published only after the smoke test passed on Linux with Docker and Podman.

### Branch Protection and the Release Commit

`@semantic-release/git` finishes the release by pushing the generated
`CHANGELOG.md`, `package.json` and `package-lock.json` directly to `main` as
the user authenticated by the `RELEASE_TOKEN` Actions secret. The repository
therefore protects `main` with a **repository ruleset**, not a classic branch
protection rule.

The `main` ruleset must:

- require pull requests for normal changes;
- require the CI checks (`Lint`, `Box (docker, x64)`, `Box (docker, arm64)` and
  `Box (podman, x64)`);
- block force pushes and branch deletion; and
- grant the **moscaverd** user, which owns the release PAT, an `Always allow`
  bypass.

The workflow uses `RELEASE_TOKEN` for checkout and as semantic-release's
`GITHUB_TOKEN`. The default Actions `GITHUB_TOKEN` authenticates as a GitHub
Actions installation, not as `github-actions[bot]`, and therefore does not
receive a bypass granted to that bot user.

When configuring the ruleset through the API, use `actor_type: "User"` and
`actor_id: 1047574` for `moscaverd`. Do not use the GitHub Actions app
(`Integration` id `15368`) as the bypass actor: GitHub rejects that built-in
integration because it is not an app installed in the repository's owner
organization.

Do not add a classic protection rule for `main` alongside the ruleset. GitHub
enforces both when they overlap, and classic protection cannot exempt
the release from required status checks on the newly created release commit.

### GitHub Release Credential

The release needs an Actions secret named `RELEASE_TOKEN`. It may be
repository-scoped or an organization secret whose repository access includes
this repository. The `kdpa-llc` organization keeps `RELEASE_TOKEN` and
`NPM_TOKEN` as organization secrets shared with selected repositories: add
`agent-box` to each one's **Repository access** under **Organization settings
→ Secrets and variables → Actions**. Its value must be a PAT owned by
`moscaverd`, with access to this repository and permission to read and write
repository contents.

GitHub does not allow an existing Actions secret's value to be read back. PAT
expiration and rotation are manual: replace the secret before expiry, then use
the release workflow's `workflow_dispatch` trigger to retry any release that
failed before publication.

### npm Credential

semantic-release publishes with `NPM_TOKEN` when it's set. Once the package
exists on npm, trusted publishing (OIDC) can replace the token: on npmjs.com,
open the `agent-box` package settings, add a trusted publisher for GitHub
Actions with repository `kdpa-llc/agent-box` and workflow `release.yml`, then
remove this repository's access to `NPM_TOKEN`. The Release workflow already
runs Node 24 with an npm version that supports it and grants `id-token: write`.

The first release is `1.0.0`, semantic-release's default when no earlier version tag exists.

### Commit Types and Version Bumps

| Commit Type | Version Bump | Example |
|-------------|--------------|---------|
| `feat:` | Minor (1.x.0) | `feat: add a TOTP shortcut` |
| `fix:` | Patch (1.0.x) | `fix: keep the vault unlocked after restart` |
| `perf:`, `refactor:`, `docs:`, `build:`, `revert:` | Patch (1.0.x) | `docs: explain the phone viewer` |
| `test:`, `ci:`, `chore:`, `style:` | None | `ci: add an arm64 job` |
| `BREAKING CHANGE:` | Major (x.0.0) | `feat!: rename type-secret` |

### Release Branches

- `main` - Production releases
- `next` - Next version (pre-release)
- `beta` - Beta releases (pre-release)
- `alpha` - Alpha releases (pre-release)

## Manual Publishing (Not Recommended)

If you need to publish manually:

### 1. Setup npm Authentication

```bash
npm login
```

### 2. Update Version

```bash
npm version patch  # 0.1.0 -> 0.1.1
npm version minor  # 0.1.0 -> 0.2.0
npm version major  # 0.1.0 -> 1.0.0
```

### 3. Test

```bash
npm run lint
npm test
```

### 4. Publish

```bash
npm publish
```

### 5. Push Changes

```bash
git push --follow-tags
```

## Verifying a Release

```bash
npm view agent-box version
npm install -g agent-box
agent-box version
```
