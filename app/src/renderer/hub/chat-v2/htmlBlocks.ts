/**
 * Streaming `html` / `htmlview` fenced-code-block extractor.
 *
 * Agents (claude-code, codex, browsercode/opencode) stream their output as
 * many small text deltas. When the model emits a fenced block like:
 *
 *     ```html
 *     <div class="plan">…</div>
 *     ```
 *
 * the renderer wants to surface that as a sandboxed-iframe artifact, not
 * as inline markdown. This module is the pure-function layer that
 * separates regular text from HTML blocks regardless of how the input
 * was chunked across `thinking` events.
 *
 * Contract: see `app/tests/unit/chat-v2/htmlBlocks.test.ts` — the
 * benchmark. Adjust the spec there, not behavior here, unless the spec
 * is wrong.
 */

export type ExtractEvent =
  | { kind: 'text'; text: string }
  | { kind: 'html_block'; content: string; tag: 'html' | 'htmlview'; complete: boolean };

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

  private state: 'text' | 'html' = 'text';
  private buffer = '';
  private currentTag: 'html' | 'htmlview' | null = null;

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
          this.state = 'html';
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
        // state === 'html'
        const closer = findCloser(this.buffer, flush);
        if (closer) {
          const content = this.buffer.slice(0, closer.start);
          out.push({
            kind: 'html_block',
            content,
            tag: this.currentTag ?? 'html',
            complete: true,
          });
          this.buffer = this.buffer.slice(closer.end);
          this.state = 'text';
          this.currentTag = null;
          progress = true;
        } else if (flush) {
          // Stream ended mid-block — emit whatever we have so the user
          // sees the partial render rather than nothing.
          out.push({
            kind: 'html_block',
            content: this.buffer,
            tag: this.currentTag ?? 'html',
            complete: false,
          });
          this.buffer = '';
          this.state = 'text';
          this.currentTag = null;
        }
        // While streaming an html block, we hold the entire buffer
        // until the closing fence resolves. That's intentional: we
        // emit the block atomically so the UI doesn't render a
        // half-formed <div> chain.
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
const OPENER_STRICT = /(^|\n)```(html|htmlview)[ \t]*\r?\n/;
const OPENER_LAX = /(^|\n)```(html|htmlview)[ \t]*(\r?\n|$)/;

function findOpener(buf: string, flush: boolean): { start: number; end: number; tag: 'html' | 'htmlview' } | null {
  const re = flush ? OPENER_LAX : OPENER_STRICT;
  const m = re.exec(buf);
  if (!m) return null;
  const leading = m[1]; // '' or '\n'
  // The text portion ends BEFORE the leading newline (if there is
  // one), so we don't leak the boundary newline into the previous
  // text event.
  const start = m.index + leading.length;
  const end = m.index + m[0].length;
  const tag = m[2] as 'html' | 'htmlview';
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
