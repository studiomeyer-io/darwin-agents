#!/usr/bin/env node
/**
 * Release guard: does the version we are about to ship still satisfy the
 * published `darwin-langgraph` peer range for `darwin-agents`?
 *
 * Why this exists: the adapter's peer cap has been broken TWICE by a
 * darwin-agents minor release (0.9.0 vs `<0.8.0` cap → S1447; 0.11.0 vs
 * `<0.11.0` cap → S1567). Each time, every fresh paired install either
 * hard-failed with ERESOLVE or silently downgraded darwin-agents. This check
 * turns the third recurrence into a red run BEFORE `npm publish` — it is
 * wired into BOTH `prepublishOnly` (publish-first workflows) and CI
 * (push/PR workflows).
 *
 * Prerelease semantics: the check judges the RELEASE COUNTERPART of the local
 * version (`1.0.0-alpha.1` → `1.0.0`), because that is what the prerelease
 * will become and what unpinned installs resolve around. If the counterpart
 * passes but the exact prerelease does not satisfy the range under npm's
 * plain-prerelease rules, that is a WARN (an explicit paired install of the
 * exact prerelease would ERESOLVE) — not a FAIL, since prereleases ship on a
 * dist-tag and do not affect default installs.
 *
 * Behaviour:
 *   - release counterpart SATISFIES the published peer range → exit 0
 *   - release counterpart ESCAPES the range → exit 1 with the fix instruction
 *   - adapter declares no peers / npm/network unavailable → warn + exit 0
 *     (never flake the build on registry hiccups; the check re-runs on every
 *     push and every publish)
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import semver from 'semver';

const ADAPTER = 'darwin-langgraph';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const localVersion = pkg.version;

let raw;
try {
  raw = execFileSync('npm', ['view', `${ADAPTER}@latest`, 'peerDependencies', '--json'], {
    encoding: 'utf8',
    timeout: 30_000,
  });
} catch (err) {
  console.warn(
    `[check-adapter-compat] WARN: could not fetch ${ADAPTER} peerDependencies from npm ` +
      `(${err instanceof Error ? err.message.split('\n')[0] : String(err)}). Skipping check.`,
  );
  process.exit(0);
}

// `npm view` prints NOTHING (not `{}`) when the field is absent.
if (!raw || raw.trim() === '') {
  console.warn(
    `[check-adapter-compat] WARN: ${ADAPTER}@latest declares no peerDependencies. Skipping check.`,
  );
  process.exit(0);
}

let peers;
try {
  peers = JSON.parse(raw);
} catch {
  console.warn(
    `[check-adapter-compat] WARN: unparseable peerDependencies output from npm view. Skipping check.`,
  );
  process.exit(0);
}

const range =
  typeof peers === 'object' && peers !== null && !Array.isArray(peers)
    ? peers[pkg.name]
    : undefined;
if (typeof range !== 'string' || range.trim() === '') {
  console.warn(
    `[check-adapter-compat] WARN: ${ADAPTER}@latest declares no "${pkg.name}" peer. Skipping check.`,
  );
  process.exit(0);
}

// Judge the release counterpart (1.0.0-alpha.1 → 1.0.0): that is the version
// this prerelease becomes, and the one npm resolves around for unpinned
// installs. npm itself checks peers with PLAIN prerelease semantics, so an
// exact-prerelease mismatch is surfaced as a WARN below.
const counterpart = semver.coerce(localVersion)?.version ?? localVersion;

if (semver.satisfies(counterpart, range)) {
  if (!semver.satisfies(localVersion, range)) {
    console.warn(
      `[check-adapter-compat] WARN: ${pkg.name}@${localVersion} itself does not satisfy ` +
        `"${range}" under npm's plain-prerelease rules — an EXPLICIT paired install of this ` +
        `exact prerelease will ERESOLVE. Dist-tag/unpinned installs are unaffected; the ` +
        `release counterpart ${counterpart} satisfies the range, so this build passes.`,
    );
  }
  console.log(
    `[check-adapter-compat] OK: ${pkg.name}@${localVersion} (counterpart ${counterpart}) ` +
      `satisfies ${ADAPTER}@latest peer "${range}".`,
  );
  process.exit(0);
}

console.error(
  [
    `[check-adapter-compat] FAIL: ${pkg.name}@${localVersion} (release counterpart ${counterpart})`,
    `ESCAPES the published ${ADAPTER}@latest peer range "${range}".`,
    '',
    `Publishing this version breaks every fresh \`npm install ${ADAPTER} ${pkg.name}\`:`,
    'explicit installs fail with ERESOLVE, unpinned installs silently downgrade',
    `${pkg.name} to the last in-range version. This has happened twice (0.9.0, 0.11.0).`,
    '',
    `Fix BEFORE publishing: release a ${ADAPTER} version whose peer range covers`,
    `${counterpart} (see ${ADAPTER}/CHANGELOG 0.5.4 for the range policy), or align`,
    'this version bump with it.',
  ].join('\n'),
);
process.exit(1);
