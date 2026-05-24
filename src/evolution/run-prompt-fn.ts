/**
 * Shared type for LLM-call injection.
 *
 * Both `PromptOptimizer` and `Reflector` accept an injected function
 * with this signature so the optimizer/reflector stays provider-agnostic.
 * Extracted to its own file (S1185 R1 Analyst Finding A1) so the
 * signature has a single source of truth — future evolution
 * (e.g. adding an `options` param) updates one declaration, not two.
 */

export type RunPromptFn = (prompt: string) => Promise<string>;
