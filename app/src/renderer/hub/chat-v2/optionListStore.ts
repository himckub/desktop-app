/**
 * Tiny in-memory cache so OptionList submitted-state survives ChatTurn
 * unmounts (tab switches). Not persisted across app reload — that case
 * needs transcript-derived state, which is a follow-up.
 *
 * Keyed by sessionId + the sorted, joined option ids — those are stable
 * for a given picker emission since the agent's emitted text doesn't
 * change once written. Two pickers with literally identical option-id
 * sets in the same session would collide (extremely unlikely; agents
 * re-scrape between turns and ids vary).
 */

const submissions = new Map<string, ReadonlySet<string>>();

export function submissionKey(sessionId: string | undefined, optionIds: string[]): string {
  const sorted = [...optionIds].sort().join('|');
  return `${sessionId ?? '(none)'}:${sorted}`;
}

export function getSubmission(key: string): ReadonlySet<string> | null {
  return submissions.get(key) ?? null;
}

export function recordSubmission(key: string, ids: Iterable<string>): void {
  submissions.set(key, new Set(ids));
}

/** Test helper — clears all cached submissions. Not used in app code. */
export function _resetSubmissionCacheForTests(): void {
  submissions.clear();
}
