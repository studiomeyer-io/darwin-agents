import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const src = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../src/evolution/build-loop.ts'),
  'utf8',
);

/**
 * v0.12.2 security tripwire — a SOURCE-level assertion, deliberately.
 *
 * The optimizer/reflector closures in buildEvolutionLoop are opaque (they
 * close over runAgent), so their run options cannot be observed from the
 * outside without spawning a real CLI. What must never regress is the
 * permission POSTURE: these are pure text mutators whose input quotes
 * untrusted agent output (critic feedback), so the spawned CLI must stay in
 * deny-by-default mode — `autonomous: true` would grant `bypassPermissions`
 * with no allowed-tools restriction (the defs declare no tools/mcp, so
 * buildAllowedTools emits none).
 */
describe('build-loop security posture (v0.12.2)', () => {
  it('optimizer/reflector never run autonomous (bypassPermissions)', () => {
    assert.ok(
      !/autonomous:\s*true/.test(src),
      'build-loop.ts must not pass autonomous: true — pure text mutators stay deny-by-default',
    );
  });

  it('both LLM closures explicitly pin autonomous: false', () => {
    const count = (src.match(/autonomous:\s*false/g) ?? []).length;
    assert.strictEqual(count, 2, 'expected exactly 2 explicit autonomous: false (optimizer + reflector)');
  });
});
