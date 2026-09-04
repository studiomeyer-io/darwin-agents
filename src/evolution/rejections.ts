/**
 * Darwin: rejection memory (v0.18.0).
 *
 * Up to v0.17 Darwin remembered which version LABELS a human had rejected
 * (`nextFreeVersion` never reuses one) but not which TEXTS. The demo path
 * builds its challenger deterministically from the active prompt plus the
 * agent's best runs, and rejecting does not change the active prompt, so a
 * rejected demo challenger came back on the next `demoEveryK` cycle with a
 * fresh label and the same text: nothing reached traffic, but the human was
 * asked the same question again. The README listed that as a known limit.
 *
 * This module is the second kind of memory. It is deliberately small and
 * pure: fingerprinting, matching, the bounded per-agent list, and the
 * reviewer notes that reach the optimizers. The loop decides what to do with
 * a match; this file only says whether there is one.
 *
 * What a fingerprint is: SHA-256 over the prompt text after whitespace
 * normalisation (CRLF to LF, trailing whitespace per line stripped, leading
 * and trailing blank lines dropped). Two texts that differ only in that are
 * the same proposal to a human reader. Two texts that differ in one word are
 * NOT: this is exact-match memory, not semantic memory, and it says so in the
 * README. A near-duplicate is a new proposal.
 */

import { createHash } from 'node:crypto';
import type { DarwinState, RejectedChallenger } from '../types.js';

/**
 * How many rejections are kept per agent. Oldest entries are dropped first.
 * Every entry needs a human decision or a lapsed timeout to exist, so the list
 * grows at human speed; the cap exists because the state blob is read on every
 * run and an unbounded list would eventually be paid for on each of them.
 */
export const REJECTION_MEMORY_CAP = 100;

/** How many reviewer reasons reach an optimizer per generation, most recent first. */
export const REJECTION_NOTES_LIMIT = 5;

/** Longest reviewer reason forwarded to an optimizer; longer ones are cut. */
export const REJECTION_REASON_CAP = 500;

/**
 * Longest reviewer reason kept in the STATE, which is a different question
 * from what an optimizer is shown and needs its own answer.
 *
 * The state blob is read on every run and rewritten on every state write. With
 * no cap here, `--reject --reason "$(cat build.log)"` stored 200 kB in one
 * entry (measured), and the list holds up to {@link REJECTION_MEMORY_CAP} of
 * them. Higher than the render cap because this is also the audit record and
 * what `darwin approve` prints back, so a little more than the optimizer sees
 * is useful; low enough that a full list stays well under a megabyte.
 */
export const REJECTION_STORED_REASON_CAP = 1000;

/**
 * Trim a reviewer's reason to what may be persisted. Returns `undefined` for
 * anything with no content, so an empty reason is an ABSENT field rather than
 * an empty string in the record.
 */
export function clampStoredReason(reason: string | undefined): string | undefined {
  if (typeof reason !== 'string') return undefined;
  const trimmed = reason.trim();
  if (trimmed === '') return undefined;
  return trimmed.length > REJECTION_STORED_REASON_CAP
    ? trimmed.slice(0, REJECTION_STORED_REASON_CAP) + ' [cut]'
    : trimmed;
}

/**
 * Normalise a prompt for fingerprinting. Exported so a caller comparing two
 * prompts by hand applies the same rule the memory does.
 */
export function normalizePromptText(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').map((line) => line.replace(/[ \t]+$/g, ''));
  while (lines.length > 0 && lines[0] === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

/** SHA-256 hex fingerprint of {@link normalizePromptText}(text). */
export function fingerprintPromptText(text: string): string {
  return createHash('sha256').update(normalizePromptText(text), 'utf8').digest('hex');
}

/**
 * The remembered rejections for one agent, oldest first. Never returns
 * `undefined` and never returns the live array: callers that mutate get a copy.
 */
export function rejectionsFor(state: DarwinState, agentName: string): RejectedChallenger[] {
  const list = state.rejectedChallengers?.[agentName];
  return Array.isArray(list) ? [...list] : [];
}

/**
 * Find the most recent remembered rejection whose fingerprint matches `text`.
 * Entries without a fingerprint (the text was unreadable when they were
 * written) can never match: they still carry a reason for the optimizer, they
 * just cannot block anything.
 */
export function findRejectedMatch(
  entries: ReadonlyArray<RejectedChallenger>,
  text: string,
): RejectedChallenger | null {
  const hash = fingerprintPromptText(text);
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if (entry.textHash !== undefined && entry.textHash === hash) return entry;
  }
  return null;
}

/**
 * Append one rejection to the agent's list inside a state object and enforce
 * the cap. Mutates and returns `state`, so it composes inside a
 * `memory.updateState` callback (the only place state may be written).
 */
export function rememberRejection(
  state: DarwinState,
  agentName: string,
  entry: RejectedChallenger,
): DarwinState {
  if (!state.rejectedChallengers) state.rejectedChallengers = {};
  const existing = state.rejectedChallengers[agentName];
  const list = Array.isArray(existing) ? existing : [];
  list.push(entry);
  while (list.length > REJECTION_MEMORY_CAP) list.shift();
  state.rejectedChallengers[agentName] = list;
  return state;
}

/**
 * Drop remembered rejections for an agent: one version label, or all of them.
 * Returns how many entries were removed. Mutates `state` like
 * {@link rememberRejection} and for the same reason.
 */
export function forgetRejections(
  state: DarwinState,
  agentName: string,
  which: string | 'all',
): number {
  const list = state.rejectedChallengers?.[agentName];
  if (!Array.isArray(list) || list.length === 0) return 0;
  if (which === 'all') {
    delete state.rejectedChallengers![agentName];
    return list.length;
  }
  const kept = list.filter((e) => e.version !== which);
  const removed = list.length - kept.length;
  if (removed > 0) {
    if (kept.length === 0) delete state.rejectedChallengers![agentName];
    else state.rejectedChallengers![agentName] = kept;
  }
  return removed;
}

/**
 * One reviewer note as the optimizers see it. Only HUMAN rejections that came
 * with a `--reason` become notes: a timeout says nothing about the text, and a
 * bare "no" gives a model nothing to act on. Those entries still block a
 * verbatim repeat; they just do not get a voice in the next generation.
 */
export interface RejectionNote {
  /** Label of the rejected version, for the model to refer to. */
  version: string;
  /** The reviewer's reason, cut to {@link REJECTION_REASON_CAP} characters. */
  reason: string;
  /** Date portion of the rejection timestamp (YYYY-MM-DD). */
  rejectedOn: string;
}

/**
 * Turn remembered rejections into the notes an optimizer receives: human,
 * with a reason, most recent first, at most {@link REJECTION_NOTES_LIMIT}.
 */
export function rejectionNotes(
  entries: ReadonlyArray<RejectedChallenger>,
  opts: { limit?: number; reasonCap?: number } = {},
): RejectionNote[] {
  const limit = clampPositiveInt(opts.limit, REJECTION_NOTES_LIMIT);
  const cap = clampPositiveInt(opts.reasonCap, REJECTION_REASON_CAP);
  const notes: RejectionNote[] = [];
  for (let i = entries.length - 1; i >= 0 && notes.length < limit; i--) {
    const entry = entries[i]!;
    if (entry.rejectedBy !== 'human') continue;
    const reason = typeof entry.reason === 'string' ? entry.reason.trim() : '';
    if (reason === '') continue;
    notes.push({
      version: entry.version,
      reason: reason.length > cap ? reason.slice(0, cap) + ' [cut]' : reason,
      rejectedOn: entry.rejectedAt.slice(0, 10),
    });
  }
  return notes;
}

/**
 * Render reviewer notes as the block both optimizers embed in their prompt.
 * One place, so the legacy meta-prompt and the GEPA feedback entry never
 * describe the constraint in two different ways. Returns '' for no notes,
 * which the callers treat as "add nothing" (byte-identical prompts).
 */
export function formatRejectionNotes(
  notes: ReadonlyArray<RejectionNote>,
  opts: { maxChars?: number } = {},
): string {
  if (notes.length === 0) return '';
  const lines: string[] = [
    'A human reviewer turned down these earlier proposals before any test ran.',
    'Each reason is a binding constraint on the new prompt: do not reintroduce what it describes,',
    'and do not propose the same text again.',
    '',
  ];
  for (const note of notes) {
    lines.push(`[${note.version}, rejected ${note.rejectedOn}] ${note.reason}`);
  }
  const block = lines.join('\n');

  // One renderer, two budgets. The legacy meta-prompt has no size limit; the
  // GEPA reflector caps each feedback entry at DEFAULT_FEEDBACK_CAP characters
  // and appends "[...truncated]" past it. Round 1 of the review did the sum:
  // five notes at the 500-character reason cap plus this preamble is about
  // 2.867 characters against a 2.000 cap, so at the DOCUMENTED defaults the
  // reflector was cutting the block, silently and mid-sentence.
  //
  // Dropping whole notes from the END (the oldest, since notes arrive
  // newest-first) beats a mid-sentence cut: half a constraint reads like a
  // different constraint. The preamble always survives, because without it the
  // remaining lines are unlabelled text.
  const max = opts.maxChars;
  if (typeof max !== 'number' || !Number.isFinite(max) || max <= 0 || block.length <= max) {
    return block;
  }
  // Room for the "not shown" line is RESERVED before deciding what fits, not
  // appended afterwards and dropped when it does not. Getting that backwards
  // hides the fact that anything was dropped, which is the one thing a reader
  // of a truncated constraint list has to know. Reserved at the worst-case
  // width (every note dropped), so the reservation never needs a second pass.
  const head = lines.slice(0, 4).join('\n');
  const tailFor = (dropped: number) => `(${dropped} older rejection(s) not shown here)`;
  const reserve = tailFor(notes.length).length + 1;
  const budget = max - reserve;

  const kept: string[] = [];
  for (const line of lines.slice(4)) {
    const candidate = [head, ...kept, line].join('\n');
    if (candidate.length > budget) break;
    kept.push(line);
  }
  // A preamble with no constraints under it is worse than nothing: it tells a
  // model that binding constraints exist and then does not name one.
  if (kept.length === 0) return '';
  return [head, ...kept, tailFor(notes.length - kept.length)].join('\n');
}

function clampPositiveInt(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) return fallback;
  return Math.floor(value);
}
