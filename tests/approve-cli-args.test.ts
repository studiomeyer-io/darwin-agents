/**
 * Argument parsing for `darwin approve` (v0.17.0).
 *
 * The CLI entry points in this repo are not unit-tested as a rule (evolve.ts,
 * status.ts and friends are exercised by hand). This one is, because its bare
 * form APPROVES: every other command can ignore an unrecognised token, here
 * that ignoring is the opposite of what was typed.
 *
 * Round 1 of the adversarial review found exactly that: `--rejct`, `-reject`
 * and `--reject=true` all parsed to `{reject: false}`, so a typo put the
 * challenger on roughly half of live traffic, and the only way to stop the
 * resulting test throws the evolved incumbent back to v1. These tests pin the
 * strictness that replaced it.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { approveCommand, parseApproveArgs } from '../src/cli/approve.js';
import { isolateTestEnv } from './helpers.js';

// This file can reach buildEvolutionLoop, which wires a real metrics sink and
// the Telegram config from the environment. Clearing them is not optional just
// because today's fixtures happen not to reach the sink: that is exactly the
// "hermetic by accident" state round 5 found and round 8 measured leaking.
isolateTestEnv();

describe('parseApproveArgs: the safe cases', () => {
  it('defaults to approve, no force, no reason, no agent', () => {
    assert.deepEqual(parseApproveArgs([]), { reject: false, force: false, errors: [] });
  });

  it('finds the agent in the plain cases', () => {
    assert.equal(parseApproveArgs(['writer']).agent, 'writer');
    assert.equal(parseApproveArgs(['writer', '--reject']).agent, 'writer');
    assert.equal(parseApproveArgs(['--reject', 'writer']).agent, 'writer');
    assert.equal(parseApproveArgs(['--force', '--reject', 'writer']).agent, 'writer');
  });

  it('reads --reject and --force in any order', () => {
    assert.equal(parseApproveArgs(['writer', '--reject']).reject, true);
    assert.equal(parseApproveArgs(['--force', 'writer']).force, true);
    const both = parseApproveArgs(['--force', '--reject', 'writer']);
    assert.equal(both.reject, true);
    assert.equal(both.force, true);
    assert.deepEqual(both.errors, []);
  });

  it('takes the --reason value wherever it sits, without eating the agent', () => {
    assert.equal(parseApproveArgs(['writer', '--reject', '--reason', 'leaks']).reason, 'leaks');
    // The failure this guards: a naive "first token without a dash" scan reads
    // "writer" as the agent here, when it is the reason.
    const r = parseApproveArgs(['--reason', 'writer']);
    assert.equal(r.reason, 'writer');
    assert.equal(r.agent, undefined, 'the reason value is not the agent');
    const both = parseApproveArgs(['--reason', 'too flat', 'researcher']);
    assert.equal(both.reason, 'too flat');
    assert.equal(both.agent, 'researcher');
  });
});

describe('parseApproveArgs: anything unrecognised is an ERROR, never a shrug', () => {
  // Every case here used to parse clean and APPROVE.
  for (const bad of ['--rejct', '-reject', '--rejectt', '--Reject', '-r']) {
    it(`refuses "${bad}" instead of approving`, () => {
      const r = parseApproveArgs(['writer', bad]);
      assert.equal(r.reject, false);
      assert.ok(r.errors.length > 0, `"${bad}" must produce an error, got none`);
      assert.ok(r.errors[0]!.includes(bad), r.errors[0]);
    });
  }

  it('refuses --flag=value without suggesting a spelling that is also wrong', () => {
    const r = parseApproveArgs(['writer', '--reject=true']);
    assert.ok(r.errors.length > 0);
    assert.ok(r.errors[0]!.includes('does not use "="'), r.errors[0]);
    // --reject is a boolean, so "--reject true" would read "true" as a second
    // agent name. The message must not hand the user that command.
    assert.ok(!r.errors[0]!.includes('--reject true'), `bad advice: ${r.errors[0]}`);
    assert.ok(r.errors[0]!.includes('flag on its own'), r.errors[0]);
  });

  it('points --reason=x at the right spelling, which does take a value', () => {
    const r = parseApproveArgs(['writer', '--reason=flat']);
    assert.ok(r.errors[0]!.includes('--reason <text>'), r.errors[0]);
  });

  it('refuses a second agent name rather than picking one', () => {
    const r = parseApproveArgs(['writer', 'researcher']);
    assert.ok(r.errors.length > 0);
    assert.ok(r.errors[0]!.includes('researcher'), r.errors[0]);
  });

  it('treats a missing --reason value as an error, not as the next flag', () => {
    const end = parseApproveArgs(['writer', '--reason']);
    assert.equal(end.reason, undefined);
    assert.ok(end.errors.length > 0);

    // The following flag must still be seen, not swallowed as the value.
    const dbl = parseApproveArgs(['writer', '--reason', '--reject']);
    assert.equal(dbl.reason, undefined);
    assert.equal(dbl.reject, true, '--reject must not be eaten as the reason');
    assert.ok(dbl.errors.length > 0);

    // Single-dash counts too (the v0.13.2 `-v` lesson). `-v` is itself unknown
    // to this command, so two errors: the missing value and the stray flag.
    const sgl = parseApproveArgs(['writer', '--reason', '-v']);
    assert.equal(sgl.reason, undefined);
    assert.equal(sgl.errors.length, 2, sgl.errors.join(' | '));
  });

  it('collects every problem rather than stopping at the first', () => {
    const r = parseApproveArgs(['writer', '--rejct', '--frce']);
    assert.equal(r.errors.length, 2, r.errors.join(' | '));
  });
});

describe('parseApproveArgs: --forget (v0.18)', () => {
  it('takes a version or "all"', () => {
    assert.equal(parseApproveArgs(['writer', '--forget', 'v4']).forget, 'v4');
    assert.equal(parseApproveArgs(['writer', '--forget', 'all']).forget, 'all');
    assert.deepEqual(parseApproveArgs(['writer', '--forget', 'v4']).errors, []);
  });

  it('treats a following flag as a MISSING value, single dash included', () => {
    // The same class the rest of this CLI was hardened against: without the
    // guard, `--forget --reject` would try to forget a version called
    // "--reject" AND swallow the rejection.
    for (const following of ['--reject', '--force', '-v']) {
      const parsed = parseApproveArgs(['writer', '--forget', following]);
      assert.equal(parsed.forget, undefined, `--forget stored "${following}" as a version`);
      assert.ok(
        parsed.errors.some((e) => e.includes('--forget needs a version')),
        `--forget ${following} must report the missing value, got: ${parsed.errors.join('; ')}`,
      );
      // `-v` collects a SECOND error from the unknown-flag branch, because it
      // is not an approve flag either. Two complaints about one typo is the
      // documented behaviour of this parser ("collects every problem rather
      // than stopping at the first"), so the count is not asserted.
    }
  });

  it('is not confused with the agent name', () => {
    const parsed = parseApproveArgs(['--forget', 'v4', 'writer']);
    assert.equal(parsed.agent, 'writer');
    assert.equal(parsed.forget, 'v4');
    assert.deepEqual(parsed.errors, []);
  });
});

describe('approveCommand refuses before it touches anything', () => {
  // Round 3 found this fix uncovered: the guard existed, was measured live at
  // exit 1, and no test called `approveCommand` at all. Deleting the guard left
  // all 825 tests green while the regression (an empty shell variable turning a
  // rejection into a listing with exit 0) came back.
  //
  // These are hermetic on purpose: every refusal below happens BEFORE
  // loadConfig/createMemory, so nothing here opens a database or reads a file.
  // If a future edit moves the guards after the I/O, this suite starts touching
  // disk and that is the signal to look.

  it('throws on an unknown flag rather than approving', async () => {
    await assert.rejects(
      () => approveCommand(['writer', '--rejct']),
      /unknown flag "--rejct"/,
    );
  });

  it('throws on a decision flag with no agent, naming the empty-variable trap', async () => {
    // `darwin approve "$AGENT" --reject` with an unset variable.
    await assert.rejects(
      () => approveCommand(['--reject']),
      /--reject needs an agent to act on/,
    );
    await assert.rejects(
      () => approveCommand(['', '--reject']),
      /--reject needs an agent to act on/,
    );
    await assert.rejects(() => approveCommand(['--force']), /--force needs an agent/);
    await assert.rejects(
      () => approveCommand(['--reason', 'too flat']),
      /--reason needs an agent/,
    );
  });

  it('names every offending flag, not just the first', async () => {
    await assert.rejects(
      () => approveCommand(['--reject', '--force']),
      /--reject, --force needs an agent/,
    );
  });

  it('refuses --forget combined with a decision, rather than picking an order', async () => {
    // v0.18: "forget v4 and also approve v5" is two commands pretending to be
    // one, and which happens first is not written down anywhere. Refusing is
    // the only answer that cannot be the wrong one.
    await assert.rejects(
      () => approveCommand(['writer', '--forget', 'v4', '--reject']),
      /cannot be combined with a decision/,
    );
    await assert.rejects(
      () => approveCommand(['writer', '--forget', 'v4', '--force']),
      /cannot be combined with a decision/,
    );
    await assert.rejects(
      () => approveCommand(['writer', '--forget', 'v4', '--reason', 'x']),
      /cannot be combined with a decision/,
    );
  });

  it('refuses --forget with no agent, naming the empty-variable trap', async () => {
    await assert.rejects(() => approveCommand(['--forget', 'v4']), /--forget needs an agent/);
    await assert.rejects(() => approveCommand(['', '--forget', 'v4']), /--forget needs an agent/);
  });

  it('throws on a second agent name rather than picking one', async () => {
    await assert.rejects(
      () => approveCommand(['writer', 'researcher']),
      /second agent name/,
    );
  });
});
