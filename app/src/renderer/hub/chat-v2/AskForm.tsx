/**
 * AskForm — questionnaire surface rendered for an `ask` fenced block.
 *
 * Each question is a small card with the question text + header chip,
 * a list of radio (single-select) or checkbox (multi-select) options,
 * plus an "Other…" affordance (unless the question opts out via
 * `allowOther: false`) with a text input the user types into.
 *
 * Submission flow mirrors OptionList — on submit we call
 * `window.electronAPI.sessions.resume(id, formattedAnswers)` which
 * lands as the next user turn. The agent reads structured answers and
 * continues.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AskFormPayload, AskQuestion } from './htmlBlocks';
import { getSubmission, recordSubmission, submissionKey } from './optionListStore';
import './askForm.css';

interface Props {
  payload: AskFormPayload | null;
  complete: boolean;
  error?: string;
  sessionId?: string;
}

const OTHER_TOKEN = '__other__';
const TRAILING_SKELETONS_WHILE_STREAMING = 1;

export function AskForm(props: Props): React.ReactElement {
  const { payload, complete, error, sessionId } = props;
  if (!payload) {
    if (complete && error) {
      return (
        <div className="chatv2-askform" data-testid="chatv2-askform" data-state="error">
          <div className="chatv2-askform__error">ask block ignored: {error}</div>
        </div>
      );
    }
    return <AskFormSkeleton />;
  }
  return <AskFormReady payload={payload} sessionId={sessionId} streaming={!complete} />;
}

function AskFormSkeleton(): React.ReactElement {
  return (
    <div className="chatv2-askform" data-testid="chatv2-askform" data-state="loading">
      {Array.from({ length: 2 }).map((_, i) => (
        <div key={i} className="chatv2-askform__question chatv2-askform__skel">
          <div className="chatv2-askform__skel-line chatv2-askform__skel-line--med" />
          {Array.from({ length: 3 }).map((__, j) => (
            <div key={j} className="chatv2-askform__skel-line chatv2-askform__skel-line--short" />
          ))}
        </div>
      ))}
    </div>
  );
}

interface ReadyProps {
  payload: AskFormPayload;
  sessionId?: string;
  streaming?: boolean;
}

function AskFormReady({ payload, sessionId, streaming }: ReadyProps): React.ReactElement {
  const { questions, prompt } = payload;
  const formRef = useRef<HTMLDivElement | null>(null);

  // Stable cache key — survives tab switches. Derived from sessionId +
  // the questions' text concatenated, since question text is stable for
  // the lifetime of the form's emission.
  const cacheKey = useMemo(() => {
    const ids = questions.map((q) => q.question);
    return `ask:${submissionKey(sessionId, ids)}`;
  }, [sessionId, questions]);
  const cachedSelection = useMemo(() => getSubmission(cacheKey), [cacheKey]);

  // Per-question selected labels. Use `Set<string>` so single + multi
  // share the same state shape; "Other" picks store the literal
  // OTHER_TOKEN. Per-question typed-other text in a parallel array.
  const [selectedByQuestion, setSelectedByQuestion] = useState<Set<string>[]>(
    () => questions.map((q) => {
      if (!cachedSelection) return new Set();
      const restored = new Set<string>();
      const validLabels = new Set([...q.options.map((o) => o.label), OTHER_TOKEN]);
      for (const id of cachedSelection) {
        const [qPrefix, ...labelParts] = id.split('::');
        if (qPrefix === q.question && validLabels.has(labelParts.join('::'))) {
          restored.add(labelParts.join('::'));
        }
      }
      return restored;
    }),
  );
  const [otherTextByQuestion, setOtherTextByQuestion] = useState<string[]>(
    () => questions.map(() => ''),
  );
  const [submitted, setSubmitted] = useState<boolean>(cachedSelection !== null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const locked = submitted;

  const togglePick = useCallback((qIdx: number, label: string): void => {
    const q = questions[qIdx];
    if (!q) return;
    setSelectedByQuestion((prev) => {
      const next = prev.slice();
      const set = new Set(prev[qIdx]);
      if (q.multiSelect) {
        if (set.has(label)) set.delete(label);
        else set.add(label);
      } else {
        set.clear();
        set.add(label);
      }
      next[qIdx] = set;
      return next;
    });
  }, [questions]);

  const setOtherText = useCallback((qIdx: number, text: string): void => {
    setOtherTextByQuestion((prev) => {
      const next = prev.slice();
      next[qIdx] = text;
      return next;
    });
  }, []);

  // Each question must have AT LEAST one selection, and if "Other" is
  // picked the text must be non-empty.
  const canSubmit = useMemo(() => {
    return questions.every((q, i) => {
      const sel = selectedByQuestion[i];
      if (!sel || sel.size === 0) return false;
      if (q.multiSelect) {
        if (sel.has(OTHER_TOKEN) && (otherTextByQuestion[i] ?? '').trim().length === 0) return false;
        return true;
      }
      // single-select
      if (sel.size !== 1) return false;
      if (sel.has(OTHER_TOKEN) && (otherTextByQuestion[i] ?? '').trim().length === 0) return false;
      return true;
    });
  }, [questions, selectedByQuestion, otherTextByQuestion]);

  const submitLabel = useMemo(() => {
    if (submitted) return 'Sent to agent';
    if (canSubmit) return 'Confirm answers';
    const unanswered = questions.reduce((n, _, i) => {
      const sel = selectedByQuestion[i];
      return n + (sel && sel.size > 0 ? 0 : 1);
    }, 0);
    if (unanswered === questions.length) return 'Answer to continue';
    if (unanswered > 0) return `${unanswered} question${unanswered === 1 ? '' : 's'} left`;
    return 'Type your "Other" answer';
  }, [submitted, canSubmit, questions, selectedByQuestion]);

  const submit = useCallback(async (): Promise<void> => {
    if (!canSubmit || locked) return;
    if (!sessionId) {
      setSubmitError('no active session');
      return;
    }
    const message = formatAnswerMessage(questions, selectedByQuestion, otherTextByQuestion);
    setSubmitted(true);
    setSubmitError(null);
    try {
      const result = await window.electronAPI?.sessions?.resume(sessionId, message);
      if (result?.error) {
        setSubmitError(result.error);
        setSubmitted(false);
      } else {
        // Persist enough to restore submitted view on remount.
        const flat: string[] = [];
        for (let i = 0; i < questions.length; i++) {
          const sel = selectedByQuestion[i] ?? new Set<string>();
          for (const label of sel) flat.push(`${questions[i].question}::${label}`);
        }
        recordSubmission(cacheKey, flat);
      }
    } catch (err) {
      setSubmitError((err as Error).message);
      setSubmitted(false);
    }
  }, [canSubmit, locked, sessionId, questions, selectedByQuestion, otherTextByQuestion, cacheKey]);

  // Auto-focus the first question on mount so kbd flow starts there.
  useEffect(() => {
    if (!submitted && formRef.current) {
      const firstInput = formRef.current.querySelector('input');
      if (firstInput instanceof HTMLInputElement) firstInput.focus({ preventScroll: true });
    }
  }, [submitted]);

  if (submitted) {
    return (
      <div className="chatv2-askform chatv2-askform--answered" data-testid="chatv2-askform" data-state="answered">
        <div className="chatv2-askform__head">
          <div className="chatv2-askform__prompt">Answered:</div>
        </div>
        {questions.map((q, qi) => {
          const sel = selectedByQuestion[qi] ?? new Set<string>();
          if (sel.size === 0) return null;
          const labels: string[] = [];
          for (const label of sel) {
            if (label === OTHER_TOKEN) labels.push(`Other: ${otherTextByQuestion[qi] ?? ''}`);
            else labels.push(label);
          }
          return (
            <div key={qi} className="chatv2-askform__answer">
              <div className="chatv2-askform__answer-label">{q.header || q.question}</div>
              <div className="chatv2-askform__answer-value">{labels.join(', ')}</div>
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div
      ref={formRef}
      className="chatv2-askform"
      data-testid="chatv2-askform"
      data-state={streaming ? 'streaming' : 'live'}
    >
      {prompt && (
        <div className="chatv2-askform__head">
          <div className="chatv2-askform__prompt">{prompt}</div>
        </div>
      )}

      {questions.map((q, qi) => (
        <QuestionCard
          key={qi}
          question={q}
          selected={selectedByQuestion[qi] ?? new Set()}
          otherText={otherTextByQuestion[qi] ?? ''}
          locked={locked}
          onToggle={(label) => togglePick(qi, label)}
          onOtherChange={(text) => setOtherText(qi, text)}
        />
      ))}

      {streaming && Array.from({ length: TRAILING_SKELETONS_WHILE_STREAMING }).map((_, i) => (
        <div key={`skel-${i}`} className="chatv2-askform__question chatv2-askform__skel" aria-hidden="true">
          <div className="chatv2-askform__skel-line chatv2-askform__skel-line--med" />
          <div className="chatv2-askform__skel-line chatv2-askform__skel-line--short" />
        </div>
      ))}

      <div className="chatv2-askform__foot">
        <button
          type="button"
          className="chatv2-askform__submit"
          disabled={!canSubmit || locked}
          onClick={() => { void submit(); }}
        >
          {submitLabel}
        </button>
        {submitError && (
          <span className="chatv2-askform__hint" style={{ color: '#ff7a7a' }}>{submitError}</span>
        )}
      </div>
    </div>
  );
}

interface QuestionProps {
  question: AskQuestion;
  selected: Set<string>;
  otherText: string;
  locked: boolean;
  onToggle: (label: string) => void;
  onOtherChange: (text: string) => void;
}

function QuestionCard({ question, selected, otherText, locked, onToggle, onOtherChange }: QuestionProps): React.ReactElement {
  const inputType = question.multiSelect ? 'checkbox' : 'radio';
  return (
    <div className="chatv2-askform__question">
      <div className="chatv2-askform__question-head">
        {question.header && <span className="chatv2-askform__question-header">{question.header}</span>}
        <span className="chatv2-askform__question-text">{question.question}</span>
      </div>
      <ul className="chatv2-askform__options" role={question.multiSelect ? 'group' : 'radiogroup'}>
        {question.options.map((opt, oi) => (
          <li key={oi} className="chatv2-askform__option">
            <label className="chatv2-askform__row">
              <input
                type={inputType}
                checked={selected.has(opt.label)}
                disabled={locked}
                onChange={() => onToggle(opt.label)}
              />
              <span className="chatv2-askform__option-label">{opt.label}</span>
              {opt.description && (
                <span className="chatv2-askform__option-desc">{opt.description}</span>
              )}
            </label>
          </li>
        ))}
        {question.allowOther && (
          <li className="chatv2-askform__option chatv2-askform__option--other">
            <label className="chatv2-askform__row">
              <input
                type={inputType}
                checked={selected.has(OTHER_TOKEN)}
                disabled={locked}
                onChange={() => onToggle(OTHER_TOKEN)}
              />
              <span className="chatv2-askform__option-label">Other</span>
              <input
                type="text"
                className="chatv2-askform__other-input"
                placeholder="type your answer…"
                value={otherText}
                disabled={locked || !selected.has(OTHER_TOKEN)}
                onChange={(e) => onOtherChange(e.target.value)}
                onFocus={() => { if (!selected.has(OTHER_TOKEN)) onToggle(OTHER_TOKEN); }}
              />
            </label>
          </li>
        )}
      </ul>
    </div>
  );
}

function formatAnswerMessage(
  questions: AskQuestion[],
  selectedByQuestion: Set<string>[],
  otherTextByQuestion: string[],
): string {
  const lines: string[] = [];
  for (let qi = 0; qi < questions.length; qi++) {
    const q = questions[qi];
    const sel = selectedByQuestion[qi] ?? new Set<string>();
    if (sel.size === 0) continue;
    const labelPrefix = q.header || q.question;
    const values: string[] = [];
    for (const label of sel) {
      if (label === OTHER_TOKEN) {
        const text = otherTextByQuestion[qi]?.trim() ?? '';
        values.push(text ? `Other: ${text}` : 'Other');
      } else {
        values.push(label);
      }
    }
    lines.push(`- ${labelPrefix}: ${values.join(', ')}`);
  }
  return `Answered:\n${lines.join('\n')}`;
}
