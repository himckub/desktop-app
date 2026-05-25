/**
 * Tiny in-memory cache so OptionList submitted-state survives ChatTurn
 * unmounts (tab switches). Not persisted across app reload — that case
 * needs transcript-derived state, which is a follow-up.
 *
 * Keyed by a structurally encoded sessionId + sorted option ids — those
 * are stable for a given picker emission since the agent's emitted text
 * doesn't change once written. Two pickers with literally identical
 * option-id sets in the same session still share submitted state, but
 * delimiters inside ids cannot move values across tuple boundaries.
 */

export interface SubmissionRecord {
  selectedIds: readonly string[];
  otherText?: readonly string[];
  otherTextByKey?: Readonly<Record<string, string>>;
}

const submissions = new Map<string, SubmissionRecord>();

export function submissionKey(sessionId: string | undefined, optionIds: string[]): string {
  return JSON.stringify({
    sessionId: sessionId ?? null,
    optionIds: [...optionIds].sort(),
  });
}

export function getSubmission(key: string): ReadonlySet<string> | null {
  const record = submissions.get(key);
  return record ? new Set(record.selectedIds) : null;
}

export function getSubmissionRecord(key: string): SubmissionRecord | null {
  return submissions.get(key) ?? null;
}

export function recordSubmission(
  key: string,
  ids: Iterable<string>,
  extra?: { otherText?: readonly string[]; otherTextByKey?: Readonly<Record<string, string>> },
): void {
  submissions.set(key, {
    selectedIds: [...ids],
    otherText: extra?.otherText ? [...extra.otherText] : undefined,
    otherTextByKey: extra?.otherTextByKey ? { ...extra.otherTextByKey } : undefined,
  });
}

/** Test helper — clears all cached submissions. Not used in app code. */
export function _resetSubmissionCacheForTests(): void {
  submissions.clear();
}
