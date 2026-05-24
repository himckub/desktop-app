/**
 * Streaming `html` / `htmlview` / `options` fenced-code-block extractor.
 *
 * Agents (claude-code, codex, browsercode/opencode) stream their output as
 * many small text deltas. When the model emits a fenced block like:
 *
 *     ```html
 *     <div class="plan">…</div>
 *     ```
 *
 * the renderer wants to surface that as a sandboxed-iframe artifact, not
 * as inline markdown. Similarly an `options` fence carrying JSON is
 * surfaced as a selectable picker, not raw code.
 *
 * Contract: see `app/tests/unit/chat-v2/htmlBlocks.test.ts` and
 * `optionBlocks.test.ts` — the benchmarks. Adjust the spec there, not
 * behavior here, unless the spec is wrong.
 */

export interface OptionItem {
  id: string;
  image: string;
  title: string;
  /** Long-form copy. Renderer clamps to ~5 lines. */
  description?: string;
  /** Arbitrary label→value rows shown at the card foot. The block's
   *  `fieldSchema` (or the union of all options' keys when no schema is
   *  declared) determines render order; missing values render as "—" so
   *  cards align vertically across the grid. */
  fields?: Record<string, string>;
  url?: string;

  // Backward-compat syntactic sugar — these get folded into `fields` /
  // `description` by the parser. New callers should set fields/description
  // directly.
  subtitle?: string;
  price?: string;
  merchant?: string;
}

export interface OptionListPayload {
  prompt?: string;
  multiSelect: boolean;
  min: number;
  max: number;
  /** Ordered list of field labels to render in every card. When present,
   *  cards align vertically — missing values render as "—". When absent,
   *  the renderer uses the union of every option's `fields` keys. */
  fieldSchema?: string[];
  options: OptionItem[];
}

export type FenceTag = 'html' | 'htmlview' | 'options';

export type ExtractEvent =
  | { kind: 'text'; text: string }
  | { kind: 'html_block'; content: string; tag: 'html' | 'htmlview'; complete: boolean }
  | { kind: 'option_list'; complete: boolean; raw: string; parsed: OptionListPayload | null; error?: string };

/**
 * Stateful, chunk-fed extractor. Safe to call `feed` once per streamed
 * text delta; events accumulate as fences resolve. Always call `end()`
 * once the upstream stream finishes — that flushes any pending text or
 * a still-open html block as `complete: false`.
 */
export class HtmlBlockExtractor {
  /**
   * Largest amount of trailing text we hold back in TEXT state to guard
   * against a fence forming across a chunk boundary. Must be >= length
   * of the longest fence opener: "\n```htmlview\n" (14 chars). Use 32
   * to leave headroom for whitespace variants.
   */
  private static readonly LOOKBACK = 32;

  private state: 'text' | 'fence' = 'text';
  private buffer = '';
  private currentTag: FenceTag | null = null;

  /** Feed the next chunk of streamed text. Returns any events that
   *  fully resolved within (or before) this chunk. */
  feed(chunk: string): ExtractEvent[] {
    if (chunk.length === 0) return [];
    this.buffer += chunk;
    return this.drain(/* flush */ false);
  }

  /** Signal end of stream. Flushes any held text and, if a block is
   *  open, emits it as `complete: false` so the UI can render what we
   *  got (or show a "stream ended mid-block" indicator). */
  end(): ExtractEvent[] {
    return this.drain(/* flush */ true);
  }

  // ---------------------------------------------------------------- internals

  private drain(flush: boolean): ExtractEvent[] {
    const out: ExtractEvent[] = [];
    let progress = true;
    while (progress) {
      progress = false;
      if (this.state === 'text') {
        const opener = findOpener(this.buffer, flush);
        if (opener) {
          if (opener.start > 0) {
            out.push({ kind: 'text', text: this.buffer.slice(0, opener.start) });
          }
          this.buffer = this.buffer.slice(opener.end);
          this.state = 'fence';
          this.currentTag = opener.tag;
          progress = true;
        } else if (flush) {
          if (this.buffer.length > 0) {
            out.push({ kind: 'text', text: this.buffer });
            this.buffer = '';
          }
        } else {
          // Hold the trailing window in case a fence is forming across
          // the next chunk boundary.
          const safeLen = Math.max(0, this.buffer.length - HtmlBlockExtractor.LOOKBACK);
          if (safeLen > 0) {
            const safe = this.buffer.slice(0, safeLen);
            // Avoid splitting just before a `\n` that could be the
            // start of `\n```html\n`. Trim back to the last newline if
            // any inside the safe portion ends within the lookback.
            out.push({ kind: 'text', text: safe });
            this.buffer = this.buffer.slice(safeLen);
          }
        }
      } else {
        // state === 'fence' — inside an html/htmlview/options block
        const closer = findCloser(this.buffer, flush);
        const tag = this.currentTag ?? 'html';
        if (closer) {
          const content = this.buffer.slice(0, closer.start);
          out.push(emitBlock(tag, content, /* complete */ true));
          this.buffer = this.buffer.slice(closer.end);
          this.state = 'text';
          this.currentTag = null;
          progress = true;
        } else if (flush) {
          // Stream ended mid-block — emit whatever we have so the user
          // sees the partial render rather than nothing.
          out.push(emitBlock(tag, this.buffer, /* complete */ false));
          this.buffer = '';
          this.state = 'text';
          this.currentTag = null;
        }
        // While streaming a fence, we hold the entire buffer
        // until the closing fence resolves. That's intentional: we
        // emit the block atomically so the UI doesn't render a
        // half-formed <div> chain or partial JSON.
      }
    }
    return out;
  }
}

/** Convenience: run a list of chunks through a fresh extractor and
 *  collect all events including the final flush. Used by tests + the
 *  HlEvent → parts adapter (which has the whole stream in hand). */
export function extractAll(chunks: string[]): ExtractEvent[] {
  const ex = new HtmlBlockExtractor();
  const out: ExtractEvent[] = [];
  for (const c of chunks) out.push(...ex.feed(c));
  out.push(...ex.end());
  return mergeAdjacentText(out);
}

// ---------------------------------------------------------------------------
// Fence detection
// ---------------------------------------------------------------------------

/**
 * Opening fence: `\`\`\`html` or `\`\`\`htmlview`, optionally preceded
 * by a newline (so the fence sits at the start of a line) and followed
 * by optional trailing whitespace and a terminator.
 *
 * Two regex variants: STRICT requires a real `\n` terminator (used
 * during streaming so we don't prematurely transition before the
 * newline arrives in the next chunk); LAX also accepts end-of-input
 * (used only during the final `end()` flush).
 */
const OPENER_STRICT = /(^|\n)```(html|htmlview|options)[ \t]*\r?\n/;
const OPENER_LAX = /(^|\n)```(html|htmlview|options)[ \t]*(\r?\n|$)/;

function findOpener(buf: string, flush: boolean): { start: number; end: number; tag: FenceTag } | null {
  const re = flush ? OPENER_LAX : OPENER_STRICT;
  const m = re.exec(buf);
  if (!m) return null;
  const leading = m[1]; // '' or '\n'
  // The text portion ends BEFORE the leading newline (if there is
  // one), so we don't leak the boundary newline into the previous
  // text event.
  const start = m.index + leading.length;
  const end = m.index + m[0].length;
  const tag = m[2] as FenceTag;
  return { start, end, tag };
}

/**
 * Closing fence: `\`\`\`` on its own line. The block content always
 * ends with the trailing newline immediately before the fence — we
 * strip it so the consumer gets clean HTML, not HTML-with-trailing-LF.
 *
 * STRICT requires a real `\n` terminator after the fence; LAX also
 * accepts end-of-input. Use LAX only at flush time so a closing fence
 * arriving as the very last token (no trailing newline) still resolves.
 */
// Lookahead so the newline that follows the closing fence stays in the
// buffer as a regular character — it belongs to whatever comes next
// (usually a paragraph break before more prose), not to the fence
// itself. STRICT requires a real \n to confirm the closer; LAX also
// accepts end-of-stream so a trailing fence with no final \n resolves
// on `end()`.
const CLOSER_STRICT = /(^|\n)```[ \t]*(?=\r?\n)/;
const CLOSER_LAX = /(^|\n)```[ \t]*(?=\r?\n|$)/;

function findCloser(buf: string, flush: boolean): { start: number; end: number } | null {
  const re = flush ? CLOSER_LAX : CLOSER_STRICT;
  const m = re.exec(buf);
  if (!m) return null;
  const leading = m[1];
  // start: position to slice the content up to (excluding the leading
  //        newline that introduces the fence line).
  const start = m.index;
  const end = m.index + m[0].length;
  void leading;
  return { start, end };
}

function mergeAdjacentText(events: ExtractEvent[]): ExtractEvent[] {
  const out: ExtractEvent[] = [];
  for (const e of events) {
    const prev = out[out.length - 1];
    if (e.kind === 'text' && prev?.kind === 'text') {
      prev.text += e.text;
    } else {
      out.push(e);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Block emission — branches on fence tag.
// ---------------------------------------------------------------------------

function emitBlock(tag: FenceTag, content: string, complete: boolean): ExtractEvent {
  if (tag === 'options') {
    // Always try to parse — even partial streams can yield complete option
    // objects that we want to render progressively. parseOptionList falls
    // back to brace-scanning when full JSON.parse fails.
    const { parsed, error } = parseOptionList(content, { partial: !complete });
    return { kind: 'option_list', complete, raw: content, parsed, error };
  }
  return { kind: 'html_block', content, tag, complete };
}

/**
 * Parse + validate an options block body. Returns the canonical payload
 * with defaults filled in, or an error string explaining why it was
 * rejected. Invalid individual options are dropped — one bad option
 * doesn't kill the whole picker. If zero options survive validation,
 * the block as a whole is rejected.
 *
 * When `partial: true` (mid-stream), falls back to scanning the buffer
 * for complete `{...}` objects inside the options array if full JSON
 * parse fails. That gives progressive card rendering instead of a flat
 * skeleton while the fence is still streaming.
 */
export function parseOptionList(raw: string, opts: { partial?: boolean } = {}): { parsed: OptionListPayload | null; error?: string } {
  // 1) Try full parse first — works at completion AND mid-stream if the
  //    JSON is incidentally valid (e.g. agent flushed a closing brace
  //    before any items arrived).
  let data: unknown = null;
  let fullParseFailed = false;
  try {
    data = JSON.parse(raw);
  } catch {
    fullParseFailed = true;
  }

  if (!fullParseFailed) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { parsed: null, error: 'expected json object at top level' };
    }
    const obj = data as Record<string, unknown>;
    const rawOptions = obj.options;
    if (!Array.isArray(rawOptions)) {
      return { parsed: null, error: 'missing required field "options" (array)' };
    }
    const options: OptionItem[] = [];
    for (const item of rawOptions) {
      const valid = validateOption(item);
      if (valid) options.push(valid);
    }
    if (options.length === 0) {
      return { parsed: null, error: 'no valid options (each option needs id, image, title)' };
    }
    return { parsed: finalizePayload(obj, options) };
  }

  // 2) Partial parse path — only when explicitly requested (mid-stream).
  if (!opts.partial) {
    return { parsed: null, error: 'invalid json' };
  }
  const partial = extractPartialPayload(raw);
  if (partial.options.length === 0) {
    return { parsed: null };
  }
  return {
    parsed: {
      prompt: partial.prompt,
      multiSelect: partial.multiSelect ?? false,
      min: partial.min ?? 1,
      max: partial.max ?? partial.options.length,
      options: partial.options,
    },
  };
}

function finalizePayload(obj: Record<string, unknown>, options: OptionItem[]): OptionListPayload {
  const multiSelect = typeof obj.multiSelect === 'boolean' ? obj.multiSelect : false;
  const min = typeof obj.min === 'number' && Number.isFinite(obj.min) ? Math.max(0, Math.floor(obj.min)) : 1;
  const max = typeof obj.max === 'number' && Number.isFinite(obj.max) ? Math.max(min, Math.floor(obj.max)) : (multiSelect ? options.length : 1);
  const fieldSchema = Array.isArray(obj.fieldSchema)
    ? (obj.fieldSchema as unknown[]).filter((x): x is string => typeof x === 'string' && x.length > 0)
    : undefined;
  return {
    prompt: typeof obj.prompt === 'string' ? obj.prompt : undefined,
    multiSelect,
    min,
    max,
    fieldSchema: fieldSchema && fieldSchema.length > 0 ? fieldSchema : undefined,
    options,
  };
}

/**
 * Scan a partial buffer for complete `{...}` option objects inside the
 * `options: [` array, plus any top-level scalar fields (prompt,
 * multiSelect, min, max) that have already streamed in. Tolerant — any
 * malformed individual object is silently skipped.
 */
function extractPartialPayload(raw: string): {
  options: OptionItem[];
  prompt?: string;
  multiSelect?: boolean;
  min?: number;
  max?: number;
} {
  const out: { options: OptionItem[]; prompt?: string; multiSelect?: boolean; min?: number; max?: number } = { options: [] };

  // Pull top-level scalars from the prefix via shallow regex. Good enough
  // for the streaming case where the prefix is well-formed up to the
  // truncation point.
  const promptMatch = raw.match(/"prompt"\s*:\s*"((?:\\.|[^"\\])*)"/);
  if (promptMatch) {
    try { out.prompt = JSON.parse(`"${promptMatch[1]}"`); } catch { /* leave undefined */ }
  }
  const msMatch = raw.match(/"multiSelect"\s*:\s*(true|false)/);
  if (msMatch) out.multiSelect = msMatch[1] === 'true';
  const minMatch = raw.match(/"min"\s*:\s*(-?\d+)/);
  if (minMatch) out.min = parseInt(minMatch[1], 10);
  const maxMatch = raw.match(/"max"\s*:\s*(-?\d+)/);
  if (maxMatch) out.max = parseInt(maxMatch[1], 10);

  // Locate `"options":[` and walk forward extracting balanced {...}.
  const arrStart = raw.search(/"options"\s*:\s*\[/);
  if (arrStart === -1) return out;
  const bracketIdx = raw.indexOf('[', arrStart);
  if (bracketIdx === -1) return out;

  let i = bracketIdx + 1;
  while (i < raw.length) {
    // Skip whitespace and commas between objects.
    while (i < raw.length && (raw[i] === ' ' || raw[i] === '\t' || raw[i] === '\n' || raw[i] === '\r' || raw[i] === ',')) i++;
    if (i >= raw.length) break;
    if (raw[i] === ']') break;
    if (raw[i] !== '{') { i++; continue; }

    const start = i;
    let depth = 0;
    let inStr = false;
    let escaped = false;
    let closed = false;
    for (; i < raw.length; i++) {
      const c = raw[i];
      if (escaped) { escaped = false; continue; }
      if (inStr) {
        if (c === '\\') escaped = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) { i++; closed = true; break; }
      }
    }
    if (!closed) break; // partial object — stop and wait for more bytes
    const slice = raw.slice(start, i);
    try {
      const obj = JSON.parse(slice);
      const v = validateOption(obj);
      if (v) out.options.push(v);
    } catch {
      // malformed — skip
    }
  }
  return out;
}

function validateOption(raw: unknown): OptionItem | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const id = typeof o.id === 'string' ? o.id.trim() : '';
  const image = typeof o.image === 'string' ? o.image.trim() : '';
  const title = typeof o.title === 'string' ? o.title.trim() : '';
  if (!id || !image || !title) return null;

  // Coerce the agent-supplied `fields` map into a clean string→string record.
  const fields: Record<string, string> = {};
  if (o.fields && typeof o.fields === 'object' && !Array.isArray(o.fields)) {
    for (const [k, v] of Object.entries(o.fields as Record<string, unknown>)) {
      if (typeof k === 'string' && k.length > 0 && (typeof v === 'string' || typeof v === 'number')) {
        fields[k] = String(v);
      }
    }
  }
  // Backward-compat sugar: fold legacy price / merchant into fields if the
  // agent didn't already set them.
  if (typeof o.price === 'string' && !('Price' in fields)) fields.Price = o.price;
  if (typeof o.merchant === 'string' && !('Merchant' in fields)) fields.Merchant = o.merchant;

  // Description: prefer explicit `description`; fall back to `subtitle`.
  const description = typeof o.description === 'string'
    ? o.description
    : (typeof o.subtitle === 'string' ? o.subtitle : undefined);

  return {
    id,
    image,
    title,
    description,
    fields: Object.keys(fields).length > 0 ? fields : undefined,
    url: typeof o.url === 'string' ? o.url : undefined,
  };
}
