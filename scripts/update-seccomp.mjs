#!/usr/bin/env node
/**
 * Regenerate chromium-seccomp.json, the seccomp profile the box runs with
 * under Docker and Podman.
 *
 * Chromium's sandbox creates user namespaces, which Docker's default profile
 * blocks unless the container has CAP_SYS_ADMIN. Rather than turn the sandbox
 * off (--no-sandbox), the box uses Docker's current default profile plus an
 * unconditional allow for clone, setns and unshare: the same change
 * Playwright's own profile makes, on an up-to-date base.
 *
 * The base must be current. An older profile that doesn't list clone3 makes
 * Podman (crun) answer it with EPERM, and glibc then fails to create threads
 * instead of falling back to clone.
 *
 *   node scripts/update-seccomp.mjs
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE = 'https://raw.githubusercontent.com/moby/profiles/main/seccomp/default.json';
const ALLOW = ['clone', 'setns', 'unshare'];
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'chromium-seccomp.json');

const res = await fetch(SOURCE);
if (!res.ok) {
  console.error(`::error::could not download ${SOURCE}: HTTP ${res.status}`);
  process.exit(1);
}
const profile = await res.json();
if (!Array.isArray(profile.syscalls) || !profile.syscalls.some((s) => s.names?.includes('clone3'))) {
  console.error('::error::the downloaded profile has an unexpected shape or no clone3 rule');
  process.exit(1);
}

profile.syscalls.push({
  names: ALLOW,
  action: 'SCMP_ACT_ALLOW',
  comment: "agent-box: Chromium's sandbox creates user namespaces",
});
writeFileSync(out, JSON.stringify(profile, null, 2) + '\n');
console.log(`wrote ${out}: Docker's default profile plus ${ALLOW.join(', ')}`);
