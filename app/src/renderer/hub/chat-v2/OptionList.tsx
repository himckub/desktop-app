/**
 * OptionList — selectable picker rendered for an `options` fenced block.
 *
 * The shopping agent emits a fence carrying a JSON payload describing
 * which products the user should choose between (see the
 * `options-block` interaction skill). The agent ends its turn after
 * emitting the fence; this component drives the human-in-the-loop
 * selection and, on submit, resumes the same session with a structured
 * "Selected: …" message that the agent reads on its next turn.
 *
 * States:
 *   - skeleton:  the fence is still streaming (or just opened) and we
 *                don't have a parsed payload yet — render shimmer cards.
 *   - error:     the closed block failed to parse — show a small
 *                explanation; the agent itself sees its own bad emission
 *                and can recover.
 *   - live:      the latest block, session is idle waiting for a pick —
 *                cards are clickable, kbd nav is wired.
 *   - history:   a block from an earlier turn that's already been
 *                answered — same visual shell but locked, with the
 *                previously-selected option highlighted (visual only;
 *                we don't replay the selection here).
 *
 * Keyboard:
 *   ← →  ↑ ↓   move focus
 *   space      toggle (multi-select)
 *   enter      single-select: pick + submit; multi-select: submit when valid
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { OptionItem, OptionListPayload, OptionListSection } from './htmlBlocks';
import { getSubmission, recordSubmission, submissionKey } from './optionListStore';
import './optionList.css';

interface Props {
  payload: OptionListPayload | null;
  complete: boolean;
  error?: string;
  sessionId?: string;
}

const SKELETON_COUNT = 3;

export function OptionList(props: Props): React.ReactElement {
  const { payload, complete, error, sessionId } = props;

  // Streaming with no options parsed yet — show a full skeleton screen.
  if (!payload) {
    if (complete && error) {
      return (
        <div className="chatv2-optlist" data-testid="chatv2-optlist" data-state="error">
          <div className="chatv2-optlist__error">options block ignored: {error}</div>
        </div>
      );
    }
    return <OptionListSkeleton />;
  }

  // We have at least one parsed option. Render the picker; if the fence
  // is still streaming, OptionListReady will tack on trailing skeleton
  // placeholders as a "more incoming" hint.
  return <OptionListReady payload={payload} sessionId={sessionId} streaming={!complete} />;
}

function OptionListSkeleton(): React.ReactElement {
  return (
    <div className="chatv2-optlist" data-testid="chatv2-optlist" data-state="loading">
      <div className="chatv2-optlist__head">
        <div className="chatv2-optlist__skel-line chatv2-optlist__skel-line--med" />
      </div>
      <div className="chatv2-optlist__grid" aria-hidden="true">
        {Array.from({ length: SKELETON_COUNT }).map((_, i) => (
          <div key={i} className="chatv2-optlist__skel-card">
            <div className="chatv2-optlist__skel-panel" />
            <div className="chatv2-optlist__skel-body">
              <div className="chatv2-optlist__skel-line chatv2-optlist__skel-line--med" />
              <div className="chatv2-optlist__skel-line chatv2-optlist__skel-line--short" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

interface ReadyProps {
  payload: OptionListPayload;
  sessionId?: string;
  /** True while the fence is still streaming — tacks on trailing skeleton
   *  placeholders after the parsed cards so the user reads "more incoming." */
  streaming?: boolean;
}

const TRAILING_SKELETONS_WHILE_STREAMING = 2;
const OTHER_TOKEN = '__other__';

function OptionListReady({ payload, sessionId, streaming }: ReadyProps): React.ReactElement {
  const { sections, prompt } = payload;
  const multi = sections.length > 1;

  // Effective field schema per section: agent-declared (preserves intent
  // + order), else the union of every option's field keys in first-seen
  // order across that section. Missing values in a card render as "—".
  const effectiveSchemas = useMemo<string[][]>(() => sections.map((sec) => {
    if (sec.fieldSchema && sec.fieldSchema.length > 0) return sec.fieldSchema;
    const seen: string[] = [];
    for (const opt of sec.options) {
      if (!opt.fields) continue;
      for (const key of Object.keys(opt.fields)) {
        if (!seen.includes(key)) seen.push(key);
      }
    }
    return seen;
  }), [sections]);

  // Stable cache key — covers ChatTurn unmounts on tab switch. Combines
  // ids across every section so picker emissions with the same option
  // sets resolve to the same key regardless of section order.
  const cacheKey = useMemo(() => {
    const allIds: string[] = [];
    for (const sec of sections) for (const o of sec.options) allIds.push(o.id);
    return submissionKey(sessionId, allIds);
  }, [sessionId, sections]);
  const cachedSelection = useMemo(() => getSubmission(cacheKey), [cacheKey]);

  // Per-section selected ids. We track one Set per section index.
  // The Set may also contain OTHER_TOKEN when the user picks "Other".
  const [selectedBySection, setSelectedBySection] = useState<Set<string>[]>(
    () => sections.map((sec) => {
      if (!cachedSelection) return new Set<string>();
      // Restore: keep ids from this section + the Other token.
      const valid = new Set([...sec.options.map((o) => o.id), OTHER_TOKEN]);
      return new Set([...cachedSelection].filter((id) => valid.has(id)));
    }),
  );
  // Per-section free-text answer when the user picks the "Other" card.
  const [otherTextBySection, setOtherTextBySection] = useState<string[]>(
    () => sections.map(() => ''),
  );
  // Cursor lives at (section, option). Arrow keys cycle within a section.
  const [cursor, setCursor] = useState<{ section: number; option: number }>({ section: 0, option: 0 });
  const [submitted, setSubmitted] = useState<boolean>(cachedSelection !== null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const gridRefs = useRef<(HTMLDivElement | null)[]>([]);
  const otherInputRefs = useRef<(HTMLTextAreaElement | null)[]>([]);

  const locked = submitted;

  const toggle = useCallback((sectionIdx: number, optionIdx: number): void => {
    const sec = sections[sectionIdx];
    const opt = sec?.options[optionIdx];
    if (!opt) return;
    setSelectedBySection((prev) => {
      const next = prev.slice();
      const set = new Set(prev[sectionIdx]);
      if (sec.multiSelect) {
        if (set.has(opt.id)) set.delete(opt.id);
        else if (set.size < sec.max) set.add(opt.id);
      } else {
        set.clear();
        set.add(opt.id);
      }
      next[sectionIdx] = set;
      return next;
    });
  }, [sections]);

  // canSubmit: every section meets its bounds AND any section that
  // has the Other card selected has non-empty typed text.
  const canSubmit = useMemo(() => {
    return sections.every((sec, i) => {
      const sel = selectedBySection[i] ?? new Set<string>();
      const n = sel.size;
      const boundsOk = sec.multiSelect ? (n >= sec.min && n <= sec.max) : (n === 1);
      if (!boundsOk) return false;
      if (sel.has(OTHER_TOKEN) && (otherTextBySection[i] ?? '').trim().length === 0) return false;
      return true;
    });
  }, [sections, selectedBySection, otherTextBySection]);

  const totalSelected = useMemo(
    () => selectedBySection.reduce((sum, s) => sum + s.size, 0),
    [selectedBySection],
  );

  const submitLabel = useMemo(() => {
    if (submitted) return totalSelected === 1 ? 'Sent to agent' : `Sent ${totalSelected} items`;
    if (multi) {
      if (canSubmit) return `Confirm ${totalSelected} pick${totalSelected === 1 ? '' : 's'}`;
      // Find the first section that's not satisfied, hint at it.
      const idx = sections.findIndex((sec, i) => {
        const n = selectedBySection[i]?.size ?? 0;
        return sec.multiSelect ? (n < sec.min || n > sec.max) : (n !== 1);
      });
      const sec = sections[idx];
      const label = sec?.label || `section ${idx + 1}`;
      return `Pick from "${label}" to continue`;
    }
    // Single-section: keep the old one-line label.
    const sec = sections[0];
    const sel = selectedBySection[0] ?? new Set<string>();
    const n = sel.size;
    if (sec.multiSelect) {
      if (n === 0) return sec.min > 1 ? `Pick at least ${sec.min}` : 'Pick options to continue';
      if (n < sec.min) return `${sec.min - n} more to continue`;
      return `Confirm ${n} item${n > 1 ? 's' : ''}`;
    }
    if (n === 1) {
      const title = sec.options.find((o) => sel.has(o.id))?.title ?? '';
      const truncated = title.length > 32 ? `${title.slice(0, 31)}…` : title;
      return `Confirm "${truncated}"`;
    }
    return 'Pick one to continue';
  }, [sections, selectedBySection, canSubmit, multi, totalSelected, submitted]);

  const submit = useCallback(async (): Promise<void> => {
    if (!canSubmit || locked) return;
    if (!sessionId) {
      setSubmitError('no active session');
      return;
    }
    const pickedAcross: { section: OptionListSection; picked: OptionItem[]; otherText: string }[] = sections.map((sec, i) => {
      const ids = selectedBySection[i] ?? new Set<string>();
      const otherText = ids.has(OTHER_TOKEN) ? (otherTextBySection[i] ?? '').trim() : '';
      return { section: sec, picked: sec.options.filter((o) => ids.has(o.id)), otherText };
    });
    const message = formatSelectionMessage(pickedAcross);
    setSubmitted(true);
    setSubmitError(null);
    try {
      const result = await window.electronAPI?.sessions?.resume(sessionId, message);
      if (result?.error) {
        setSubmitError(result.error);
        setSubmitted(false);
      } else {
        const flat: string[] = [];
        for (let i = 0; i < sections.length; i++) {
          const ids = selectedBySection[i] ?? new Set<string>();
          for (const id of ids) flat.push(id);
        }
        recordSubmission(cacheKey, flat);
      }
    } catch (err) {
      setSubmitError((err as Error).message);
      setSubmitted(false);
    }
  }, [canSubmit, locked, sessionId, sections, selectedBySection, otherTextBySection, cacheKey]);

  const handleSectionKey = useCallback((sectionIdx: number, e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (locked) return;
    const sec = sections[sectionIdx];
    if (!sec || sec.options.length === 0) return;
    const n = sec.options.length;
    const cur = cursor.section === sectionIdx ? cursor.option : 0;
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        e.preventDefault();
        setCursor({ section: sectionIdx, option: (cur + 1) % n });
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        e.preventDefault();
        setCursor({ section: sectionIdx, option: (cur - 1 + n) % n });
        break;
      case ' ':
        e.preventDefault();
        toggle(sectionIdx, cur);
        break;
      case 'Enter':
        e.preventDefault();
        if (multi) {
          if (canSubmit) void submit();
        } else if (sec.multiSelect) {
          if (canSubmit) void submit();
        } else {
          toggle(sectionIdx, cur);
          setTimeout(() => { void submit(); }, 0);
        }
        break;
      default:
        break;
    }
  }, [locked, sections, cursor, multi, canSubmit, toggle, submit]);

  // Auto-focus the first section's grid on mount so kbd nav works
  // without an initial click.
  useEffect(() => {
    if (!submitted && gridRefs.current[0]) {
      gridRefs.current[0].focus({ preventScroll: true });
    }
  }, [submitted]);

  // Post-submit: compact "Chose: …" view across every section.
  if (submitted) {
    return (
      <div
        className="chatv2-optlist chatv2-optlist--chosen"
        data-testid="chatv2-optlist"
        data-state="chosen"
        data-multi={multi}
      >
        <div className="chatv2-optlist__head">
          <div className="chatv2-optlist__prompt">
            {multi ? 'Chose:' : `Chose: ${formatChosenSummary(sections, selectedBySection, otherTextBySection)}`}
          </div>
          <div className="chatv2-optlist__meta">sent to agent</div>
        </div>
        {sections.map((sec, sIdx) => {
          const sel = selectedBySection[sIdx] ?? new Set<string>();
          const chosen = sec.options.filter((o) => sel.has(o.id));
          const otherPicked = sel.has(OTHER_TOKEN);
          if (chosen.length === 0 && !otherPicked) return null;
          return (
            <div key={sIdx} className="chatv2-optlist__section">
              {(multi && sec.label) && (
                <div className="chatv2-optlist__section-label">{sec.label}</div>
              )}
              <div className="chatv2-optlist__grid" aria-hidden="false">
                {chosen.map((opt) => (
                  <OptionCard
                    key={opt.id}
                    opt={opt}
                    fieldSchema={effectiveSchemas[sIdx] ?? []}
                    selected
                    focused={false}
                    disabled
                    onClick={() => { /* locked */ }}
                    onHover={() => { /* locked */ }}
                  />
                ))}
                {otherPicked && (
                  <div className="chatv2-optlist__card chatv2-optlist__card--other" data-selected="true">
                    <div className="chatv2-optlist__panel chatv2-optlist__panel--other">
                      <span className="chatv2-optlist__other-glyph" aria-hidden="true">+</span>
                    </div>
                    <div className="chatv2-optlist__body">
                      <div className="chatv2-optlist__title">Other</div>
                      {(otherTextBySection[sIdx] ?? '').trim() && (
                        <p className="chatv2-optlist__desc">{otherTextBySection[sIdx]}</p>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div
      className="chatv2-optlist"
      data-testid="chatv2-optlist"
      data-state={streaming ? 'streaming' : 'live'}
      data-multi={multi}
    >
      <div className="chatv2-optlist__head">
        {prompt && <div className="chatv2-optlist__prompt">{prompt}</div>}
        <div className="chatv2-optlist__meta">
          {multi
            ? `${sections.length} sections · ${totalSelected} picked${streaming ? ' · loading more…' : ''}`
            : (() => {
                const sec = sections[0];
                let s = `${sec.options.length} option${sec.options.length === 1 ? '' : 's'}`;
                if (streaming) s += ' · loading more…';
                if (sec.multiSelect && sec.min === sec.max) s += ` · pick exactly ${sec.min}`;
                if (sec.multiSelect && sec.min !== sec.max) s += ` · pick ${sec.min}–${sec.max}`;
                return s;
              })()}
        </div>
      </div>

      {sections.map((sec, sIdx) => {
        const sel = selectedBySection[sIdx] ?? new Set<string>();
        const isLastSection = sIdx === sections.length - 1;
        return (
          <div key={sIdx} className="chatv2-optlist__section">
            {multi && (
              <div className="chatv2-optlist__section-head">
                {sec.label && <div className="chatv2-optlist__section-label">{sec.label}</div>}
                <div className="chatv2-optlist__section-meta">
                  {sec.options.length} option{sec.options.length === 1 ? '' : 's'}
                  {sec.multiSelect && sec.min === sec.max && ` · pick exactly ${sec.min}`}
                  {sec.multiSelect && sec.min !== sec.max && ` · pick ${sec.min}–${sec.max}`}
                  {!sec.multiSelect && ' · pick one'}
                </div>
              </div>
            )}
            <div
              ref={(el) => { gridRefs.current[sIdx] = el; }}
              className="chatv2-optlist__grid"
              tabIndex={locked ? -1 : 0}
              onKeyDown={(e) => handleSectionKey(sIdx, e)}
            >
              {sec.options.map((opt, idx) => (
                <OptionCard
                  key={opt.id}
                  opt={opt}
                  fieldSchema={effectiveSchemas[sIdx] ?? []}
                  selected={sel.has(opt.id)}
                  focused={!locked && cursor.section === sIdx && cursor.option === idx}
                  disabled={locked}
                  onClick={() => {
                    if (locked) return;
                    setCursor({ section: sIdx, option: idx });
                    toggle(sIdx, idx);
                    gridRefs.current[sIdx]?.focus({ preventScroll: true });
                  }}
                  onHover={() => { if (!locked) setCursor({ section: sIdx, option: idx }); }}
                />
              ))}
              {sec.allowOther && (
                <OtherCard
                  selected={sel.has(OTHER_TOKEN)}
                  text={otherTextBySection[sIdx] ?? ''}
                  disabled={locked}
                  inputRef={(el) => { otherInputRefs.current[sIdx] = el; }}
                  onPick={() => {
                    if (locked) return;
                    setSelectedBySection((prev) => {
                      const next = prev.slice();
                      const set = new Set(prev[sIdx]);
                      if (sec.multiSelect) {
                        if (set.has(OTHER_TOKEN)) set.delete(OTHER_TOKEN);
                        else if (set.size < sec.max) set.add(OTHER_TOKEN);
                      } else {
                        set.clear();
                        set.add(OTHER_TOKEN);
                      }
                      next[sIdx] = set;
                      return next;
                    });
                    // Auto-focus the text input on first pick so the user
                    // can type immediately without an extra click.
                    setTimeout(() => otherInputRefs.current[sIdx]?.focus(), 0);
                  }}
                  onTextChange={(text) => {
                    setOtherTextBySection((prev) => {
                      const next = prev.slice();
                      next[sIdx] = text;
                      return next;
                    });
                    // Typing implies picking the Other card.
                    if (!sel.has(OTHER_TOKEN)) {
                      setSelectedBySection((prev) => {
                        const next = prev.slice();
                        const set = new Set(prev[sIdx]);
                        if (sec.multiSelect && set.size < sec.max) set.add(OTHER_TOKEN);
                        else if (!sec.multiSelect) { set.clear(); set.add(OTHER_TOKEN); }
                        next[sIdx] = set;
                        return next;
                      });
                    }
                  }}
                />
              )}
              {streaming && isLastSection && Array.from({ length: TRAILING_SKELETONS_WHILE_STREAMING }).map((_, i) => (
                <div key={`skel-${i}`} className="chatv2-optlist__skel-card" aria-hidden="true">
                  <div className="chatv2-optlist__skel-panel" />
                  <div className="chatv2-optlist__skel-body">
                    <div className="chatv2-optlist__skel-line chatv2-optlist__skel-line--med" />
                    <div className="chatv2-optlist__skel-line chatv2-optlist__skel-line--short" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })}

      <div className="chatv2-optlist__foot">
        <button
          type="button"
          className="chatv2-optlist__submit"
          disabled={!canSubmit || locked}
          onClick={() => { void submit(); }}
        >
          {submitLabel}
        </button>
        {submitError ? (
          <span className="chatv2-optlist__hint" style={{ color: '#ff7a7a' }}>{submitError}</span>
        ) : (
          <span className="chatv2-optlist__hint">
            <span className="chatv2-optlist__kbd">←</span>
            <span className="chatv2-optlist__kbd">→</span>navigate ·
            <span className="chatv2-optlist__kbd">↵</span>confirm
          </span>
        )}
      </div>
    </div>
  );
}

function formatChosenSummary(
  sections: OptionListSection[],
  selectedBySection: Set<string>[],
  otherTextBySection: string[],
): string {
  const titles: string[] = [];
  sections.forEach((sec, i) => {
    const sel = selectedBySection[i] ?? new Set<string>();
    for (const opt of sec.options) if (sel.has(opt.id)) titles.push(opt.title);
    if (sel.has(OTHER_TOKEN)) {
      const text = (otherTextBySection[i] ?? '').trim();
      titles.push(text ? `Other: ${text}` : 'Other');
    }
  });
  return titles.join(', ');
}

interface CardProps {
  opt: OptionItem;
  /** Field labels to render in order across every card; cells missing
   *  the corresponding value render as "—" to keep alignment. */
  fieldSchema: string[];
  selected: boolean;
  focused: boolean;
  disabled: boolean;
  onClick: () => void;
  onHover: () => void;
}

const MISSING_FIELD_GLYPH = '—';

function OptionCard({ opt, fieldSchema, selected, focused, disabled, onClick, onHover }: CardProps): React.ReactElement {
  const [broken, setBroken] = useState<boolean>(false);
  return (
    <button
      type="button"
      className="chatv2-optlist__card"
      data-selected={selected}
      data-focused={focused}
      disabled={disabled}
      onClick={onClick}
      onMouseEnter={onHover}
    >
      <div className="chatv2-optlist__panel">
        {!broken ? (
          <img
            className="chatv2-optlist__img"
            src={opt.image}
            alt=""
            loading="lazy"
            onError={() => setBroken(true)}
          />
        ) : (
          <div className="chatv2-optlist__img chatv2-optlist__img--broken">no image</div>
        )}
        <span className="chatv2-optlist__pin" aria-hidden="true">✓</span>
      </div>
      <div className="chatv2-optlist__body">
        <div className="chatv2-optlist__title">{opt.title}</div>
        {opt.description && <p className="chatv2-optlist__desc">{opt.description}</p>}
        {fieldSchema.length > 0 && (
          <dl className="chatv2-optlist__fields">
            {fieldSchema.map((label) => {
              const value = opt.fields?.[label];
              return (
                <div key={label} className="chatv2-optlist__field">
                  <dt className="chatv2-optlist__field-label">{label}</dt>
                  <dd className="chatv2-optlist__field-value" data-missing={!value}>
                    {value ?? MISSING_FIELD_GLYPH}
                  </dd>
                </div>
              );
            })}
          </dl>
        )}
      </div>
    </button>
  );
}

interface OtherCardProps {
  selected: boolean;
  text: string;
  disabled: boolean;
  inputRef: (el: HTMLTextAreaElement | null) => void;
  onPick: () => void;
  onTextChange: (text: string) => void;
}

/**
 * The "Other — describe…" card appended to every section grid (unless
 * `allowOther: false`). No image, dashed border, transforms to a text
 * input affordance on pick. Lets the user write a custom answer the
 * agent didn't list.
 */
function OtherCard({ selected, text, disabled, inputRef, onPick, onTextChange }: OtherCardProps): React.ReactElement {
  return (
    <div
      className="chatv2-optlist__card chatv2-optlist__card--other"
      data-selected={selected}
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled}
      onClick={(e) => {
        if (disabled) return;
        // Clicks on the textarea shouldn't re-pick (let the input own its
        // own focus/typing); only outer-card clicks pick.
        if (e.target instanceof HTMLTextAreaElement) return;
        onPick();
      }}
      onKeyDown={(e) => {
        if (disabled) return;
        // Only treat Enter/Space as "pick" when the textarea isn't focused
        // — otherwise the user can't type newlines / spaces in their answer.
        if (e.target instanceof HTMLTextAreaElement) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onPick();
        }
      }}
    >
      <div className="chatv2-optlist__panel chatv2-optlist__panel--other">
        <span className="chatv2-optlist__other-glyph" aria-hidden="true">+</span>
        <span className="chatv2-optlist__other-label">Describe what you want</span>
      </div>
      <div className="chatv2-optlist__body chatv2-optlist__body--other">
        <textarea
          ref={inputRef}
          className="chatv2-optlist__other-input"
          placeholder="Type your answer…"
          value={text}
          disabled={disabled}
          rows={3}
          onChange={(e) => onTextChange(e.target.value)}
          onClick={(e) => e.stopPropagation()}
        />
      </div>
    </div>
  );
}

/**
 * Build the structured user message that resumes the agent's turn.
 * Single-section single-pick → one-liner. Multi-section or multi-pick
 * → bulleted list. Multi-section lines are prefixed with the section
 * label so the agent can route picks back to categories.
 */
function formatSelectionMessage(pickedAcross: { section: OptionListSection; picked: OptionItem[]; otherText: string }[]): string {
  const totalCount = pickedAcross.reduce((n, { picked, otherText }) => n + picked.length + (otherText ? 1 : 0), 0);
  if (totalCount === 0) return 'Selected: (none)';

  // Single section, single pick → terse one-liner.
  const totalSections = pickedAcross.length;
  if (totalSections === 1 && totalCount === 1) {
    const sec = pickedAcross[0];
    if (sec.picked.length === 1) {
      const p = sec.picked[0];
      return `Selected from options: ${p.title} (id: ${p.id})`;
    }
    return `Selected from options: Other: ${sec.otherText}`;
  }

  // Otherwise bulleted. Prefix with section label when there's more than
  // one section so the agent can route picks back to categories. Other
  // picks render as `Other: <typed text>` on their own line.
  const lines: string[] = [];
  for (const { section, picked, otherText } of pickedAcross) {
    const prefix = totalSections > 1 && section.label ? `${section.label}: ` : '';
    for (const p of picked) {
      lines.push(`- ${prefix}${p.title} (id: ${p.id})`);
    }
    if (otherText) {
      lines.push(`- ${prefix}Other: ${otherText}`);
    }
  }
  return `Selected from options:\n${lines.join('\n')}`;
}
