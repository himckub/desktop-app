/**
 * HtmlBlock — sandboxed iframe surface for agent-emitted HTML artifacts.
 *
 * Security model
 * --------------
 * The agent is untrusted. We render its HTML inside an <iframe> with a
 * restrictive `sandbox` attribute and feed the content via `srcdoc`
 * (not src) so it never traverses a real URL or originates a request.
 *
 * sandbox = "allow-same-origin"
 *   - NO `allow-scripts` → no JavaScript executes inside the artifact.
 *     Static HTML + CSS only. CSS can still animate via @keyframes.
 *   - `allow-same-origin` is required so the parent renderer can read
 *     contentDocument.documentElement.scrollHeight to auto-resize.
 *     This gives the iframe document the same origin as the renderer.
 *     Without scripts running inside, there's no path to read parent
 *     state — the dangerous combo (`allow-scripts allow-same-origin`)
 *     is what we're explicitly avoiding.
 *   - No `allow-top-navigation`, no `allow-popups`, no `allow-forms` —
 *     the artifact cannot navigate the parent or open new tabs.
 *
 * Layout
 * ------
 * The iframe height is measured on load + on every ResizeObserver tick.
 * Capped at MAX_HEIGHT_PX (default 720) — taller content is rendered
 * as collapsed-by-default with an "Expand" toggle. The fallback height
 * (180) is used during the brief flicker before onLoad fires so the
 * card never collapses to 0.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import './htmlBlock.css';

const MAX_HEIGHT_PX = 720;
const COLLAPSED_HEIGHT_PX = 360;
const FALLBACK_HEIGHT_PX = 180;

interface Props {
  content: string;
  /** Whether the upstream extractor reached the closing fence. When false
   *  the UI shows a "streaming" badge so the partial render reads as
   *  intentional rather than broken. */
  complete?: boolean;
  /** Tag from the fence — informational only ("html" vs "htmlview"). */
  tag?: 'html' | 'htmlview';
}

export function HtmlBlock({ content, complete = true, tag = 'html' }: Props): React.ReactElement {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [naturalHeight, setNaturalHeight] = useState<number>(FALLBACK_HEIGHT_PX);
  const [collapsed, setCollapsed] = useState<boolean>(false);

  const measureAndSet = useCallback(() => {
    const ifr = iframeRef.current;
    if (!ifr) return;
    const doc = ifr.contentDocument;
    if (!doc) return;
    // documentElement.scrollHeight reflects the real layout height of
    // the iframe content. Read both <html> and <body> in case the
    // artifact sets one but not the other.
    const docEl = doc.documentElement;
    const bodyEl = doc.body;
    const measured = Math.max(
      docEl?.scrollHeight ?? 0,
      bodyEl?.scrollHeight ?? 0,
      FALLBACK_HEIGHT_PX,
    );
    setNaturalHeight(measured);
    // Auto-collapse on the *first* measurement when content overflows
    // the cap. Detected by checking that naturalHeight is still its
    // initial fallback value at this call (state hasn't been updated
    // yet — that closes around the prior render's value).
    if (measured > MAX_HEIGHT_PX && naturalHeight === FALLBACK_HEIGHT_PX) {
      setCollapsed(true);
    }
  }, [naturalHeight]);

  // Re-measure on load and on any subsequent DOM mutation. Without
  // scripts inside the iframe the document rarely resizes after load,
  // but we still want to react to font loads / image decodes that
  // shift layout.
  const handleLoad = useCallback(() => {
    measureAndSet();
    const ifr = iframeRef.current;
    if (!ifr?.contentDocument) return;
    const doc = ifr.contentDocument;
    let ro: ResizeObserver | null = null;
    try {
      ro = new ResizeObserver(() => measureAndSet());
      if (doc.documentElement) ro.observe(doc.documentElement);
      if (doc.body) ro.observe(doc.body);
    } catch {
      // ResizeObserver unavailable — initial measurement still works.
    }
    // Stash the observer on the iframe so we can disconnect on
    // unmount via the dataset (avoids needing a separate ref).
    (ifr as unknown as { __htmlBlockRO?: ResizeObserver | null }).__htmlBlockRO = ro;
  }, [measureAndSet]);

  useEffect(() => {
    return () => {
      const ifr = iframeRef.current as unknown as { __htmlBlockRO?: ResizeObserver | null } | null;
      ifr?.__htmlBlockRO?.disconnect();
    };
  }, []);

  // When the content prop changes (e.g. additional streaming arrived
  // and the parent re-rendered), reset measurement so layout re-runs.
  useEffect(() => {
    setNaturalHeight(FALLBACK_HEIGHT_PX);
  }, [content]);

  const cappedHeight = collapsed
    ? Math.min(naturalHeight, COLLAPSED_HEIGHT_PX)
    : Math.min(naturalHeight, MAX_HEIGHT_PX);
  const overflows = naturalHeight > MAX_HEIGHT_PX;

  return (
    <div
      className={`chatv2-htmlblock${complete ? '' : ' chatv2-htmlblock--streaming'}`}
      data-testid="chatv2-htmlblock"
      data-complete={complete}
      data-tag={tag}
    >
      <iframe
        ref={iframeRef}
        className="chatv2-htmlblock__frame"
        title={tag === 'htmlview' ? 'HTML view' : 'HTML artifact'}
        // No `allow-scripts`. allow-same-origin is required for the
        // parent to read contentDocument.scrollHeight. See file header.
        sandbox="allow-same-origin"
        srcDoc={wrap(content)}
        onLoad={handleLoad}
        style={{ height: `${cappedHeight}px` }}
      />
      <div className="chatv2-htmlblock__bar">
        <span className="chatv2-htmlblock__tag">{tag}</span>
        {!complete && <span className="chatv2-htmlblock__badge">streaming…</span>}
        {overflows && (
          <button
            type="button"
            className="chatv2-htmlblock__toggle"
            onClick={() => setCollapsed((v) => !v)}
            aria-expanded={!collapsed}
          >
            {collapsed ? 'Expand' : 'Collapse'}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Wrap raw block content in a minimal HTML document with a baseline
 * stylesheet that inherits the renderer's color tokens (via inline
 * CSS variables) so artifacts feel native rather than browser-default
 * Times-New-Roman. The agent's own styles can override.
 *
 * Includes:
 *   - `<base target="_blank">` so any <a href=...> opens in the user's
 *     default browser, never inside the iframe (which would be a no-op
 *     under our sandbox).
 *   - `body { margin: 0 }` so measurement matches the actual content.
 *   - `box-sizing: border-box` globally — anything else makes the
 *     scrollHeight math fight you.
 */
function wrap(content: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>
    *, *::before, *::after { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; }
    body {
      color: #e8e8e8;
      background: transparent;
      font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      padding: 12px 14px;
    }
    a { color: #79b8ff; text-decoration: none; }
    a:hover { text-decoration: underline; }
    h1, h2, h3, h4 { margin: 0.5em 0 0.3em; line-height: 1.25; }
    p { margin: 0 0 0.6em; }
    ul, ol { margin: 0 0 0.6em 1.2em; padding: 0; }
    li { margin-bottom: 0.2em; }
    code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; }
    pre {
      background: rgba(255, 255, 255, 0.06);
      padding: 8px 10px;
      border-radius: 4px;
      overflow-x: auto;
    }
    table { border-collapse: collapse; width: 100%; }
    th, td { padding: 6px 10px; border-bottom: 1px solid rgba(255, 255, 255, 0.08); text-align: left; }
    th { font-weight: 600; color: #cfcfcf; }
    hr { border: 0; border-top: 1px solid rgba(255, 255, 255, 0.1); margin: 12px 0; }
    img { max-width: 100%; height: auto; }
  </style></head><body>${content}</body></html>`;
}
