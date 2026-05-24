/**
 * Spec for the `options` fence — emitted by shopping agents to surface a
 * selectable picker. Shares the extractor / state machine with html
 * blocks (same file) but the closed-fence event is `option_list` with
 * parsed JSON, and per-option schema validation drops malformed items.
 *
 * If a test fails, the bug is in `htmlBlocks.ts`, NOT the test.
 */

import { describe, expect, it } from 'vitest';
import { extractAll, parseOptionList, type ExtractEvent } from '@/renderer/hub/chat-v2/htmlBlocks';

function stream(s: string, n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out;
}
const stream1 = (s: string) => stream(s, 1);

function run(chunks: string[]): ExtractEvent[] {
  return extractAll(chunks);
}

const SAMPLE = {
  prompt: 'Which SSD?',
  multiSelect: false,
  options: [
    { id: 'a1', image: 'https://cdn/x.jpg', title: 'Samsung 990 Pro', price: '$169' },
    { id: 'a2', image: 'https://cdn/y.jpg', title: 'WD Black SN850X', price: '$149' },
  ],
};

const fenced = (body: string): string => '```options\n' + body + '\n```';

describe('options fence — extraction', () => {
  it('emits option_list with parsed payload on a clean block', () => {
    const events = run([fenced(JSON.stringify(SAMPLE))]);
    expect(events).toHaveLength(1);
    const ev = events[0];
    expect(ev.kind).toBe('option_list');
    if (ev.kind !== 'option_list') throw new Error('unreachable');
    expect(ev.complete).toBe(true);
    expect(ev.parsed?.options).toHaveLength(2);
    expect(ev.parsed?.prompt).toBe('Which SSD?');
    expect(ev.parsed?.options[0].id).toBe('a1');
  });

  it('is invariant under char-by-char chunking', () => {
    const events = run(stream1(fenced(JSON.stringify(SAMPLE))));
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('option_list');
    if (events[0].kind !== 'option_list') return;
    expect(events[0].parsed?.options).toHaveLength(2);
  });

  it.each([2, 3, 7, 13, 50, 200])('is invariant under chunk size %i', (n) => {
    const events = run(stream(fenced(JSON.stringify(SAMPLE)), n));
    expect(events.filter((e) => e.kind === 'option_list')).toHaveLength(1);
  });

  it('preserves surrounding text', () => {
    const events = run([
      'Here are some choices:\n' + fenced(JSON.stringify(SAMPLE)) + '\nPick one.',
    ]);
    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual(['text', 'option_list', 'text']);
  });

  it('coexists with an html block in the same stream', () => {
    const html = '```html\n<div>hi</div>\n```';
    const opts = fenced(JSON.stringify(SAMPLE));
    const events = run([html + '\n' + opts]);
    // Filter empty inter-block whitespace; we only care that both blocks resolved
    // in order with their parsed payloads.
    const meaningful = events.filter((e) => e.kind !== 'text' || e.text.trim().length > 0);
    expect(meaningful.map((e) => e.kind)).toEqual(['html_block', 'option_list']);
  });

  it('emits a partial option_list with complete:false when stream ends mid-block', () => {
    const partial = '```options\n{"options":[{"id":"a1","image":"x","title":"y"';
    const events = run([partial]);
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('option_list');
    if (events[0].kind !== 'option_list') return;
    expect(events[0].complete).toBe(false);
    // No closed inner object — nothing to render yet.
    expect(events[0].parsed).toBeNull();
  });

  it('progressively parses complete inner objects mid-stream', () => {
    // Two complete inner objects, third object opens but isn't closed.
    const partial =
      '```options\n{"prompt":"Pick a patty","multiSelect":true,"min":1,"max":2,"options":['
      + '{"id":"a1","image":"i1","title":"Beyond"},'
      + '{"id":"a2","image":"i2","title":"Beef 85/15"},'
      + '{"id":"a3","image":"i3"';
    const events = run([partial]);
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e.kind).toBe('option_list');
    if (e.kind !== 'option_list') return;
    expect(e.complete).toBe(false);
    expect(e.parsed).not.toBeNull();
    expect(e.parsed?.options).toHaveLength(2);
    expect(e.parsed?.options.map((o) => o.id)).toEqual(['a1', 'a2']);
    expect(e.parsed?.prompt).toBe('Pick a patty');
    expect(e.parsed?.multiSelect).toBe(true);
    expect(e.parsed?.min).toBe(1);
    expect(e.parsed?.max).toBe(2);
  });

  it('renders parsed cards even when trailing comma and EOF arrive', () => {
    const partial =
      '```options\n{"options":['
      + '{"id":"a1","image":"i1","title":"A"},'
      + '{"id":"a2","image":"i2","title":"B"},';
    const events = run([partial]);
    const e = events[0];
    if (e.kind !== 'option_list') throw new Error('expected option_list');
    expect(e.parsed?.options).toHaveLength(2);
  });

  it('handles strings containing braces inside option titles', () => {
    const partial =
      '```options\n{"options":['
      + '{"id":"a1","image":"i1","title":"Brand {limited edition}"},'
      + '{"id":"a2","image":"i2","title":"Plain"';
    const events = run([partial]);
    const e = events[0];
    if (e.kind !== 'option_list') throw new Error('expected option_list');
    expect(e.parsed?.options).toHaveLength(1);
    expect(e.parsed?.options[0].title).toBe('Brand {limited edition}');
  });
});

describe('parseOptionList — validation', () => {
  it('rejects invalid JSON', () => {
    const { parsed, error } = parseOptionList('{ this is not json');
    expect(parsed).toBeNull();
    expect(error).toMatch(/invalid json/);
  });

  it('rejects when options field is missing', () => {
    const { parsed, error } = parseOptionList('{"prompt":"hi"}');
    expect(parsed).toBeNull();
    expect(error).toMatch(/options/);
  });

  it('drops malformed individual options', () => {
    const { parsed } = parseOptionList(JSON.stringify({
      options: [
        { id: 'ok', image: 'i', title: 't' },
        { id: 'no-title', image: 'i' },          // dropped — no title
        { image: 'i', title: 't' },              // dropped — no id
        { id: 'no-image', title: 't' },          // dropped — no image
        { id: 'ok2', image: 'i2', title: 't2' },
      ],
    }));
    expect(parsed?.options.map((o) => o.id)).toEqual(['ok', 'ok2']);
  });

  it('rejects when zero options survive', () => {
    const { parsed, error } = parseOptionList(JSON.stringify({ options: [{ id: 'x' }] }));
    expect(parsed).toBeNull();
    expect(error).toMatch(/no valid options/);
  });

  it('defaults multiSelect=false, min=1, max=1 when omitted', () => {
    const { parsed } = parseOptionList(JSON.stringify({
      options: [{ id: 'a', image: 'i', title: 't' }],
    }));
    expect(parsed?.multiSelect).toBe(false);
    expect(parsed?.min).toBe(1);
    expect(parsed?.max).toBe(1);
  });

  it('honors multiSelect with min/max bounds', () => {
    const { parsed } = parseOptionList(JSON.stringify({
      multiSelect: true,
      min: 2,
      max: 3,
      options: [
        { id: 'a', image: 'i', title: 't' },
        { id: 'b', image: 'i', title: 't' },
        { id: 'c', image: 'i', title: 't' },
        { id: 'd', image: 'i', title: 't' },
      ],
    }));
    expect(parsed?.multiSelect).toBe(true);
    expect(parsed?.min).toBe(2);
    expect(parsed?.max).toBe(3);
  });

  it('clamps max below min to min', () => {
    const { parsed } = parseOptionList(JSON.stringify({
      multiSelect: true,
      min: 3,
      max: 1,
      options: [
        { id: 'a', image: 'i', title: 't' },
        { id: 'b', image: 'i', title: 't' },
        { id: 'c', image: 'i', title: 't' },
      ],
    }));
    expect(parsed?.min).toBe(3);
    expect(parsed?.max).toBe(3);
  });

  it('folds legacy price/subtitle/merchant into fields + description', () => {
    const { parsed } = parseOptionList(JSON.stringify({
      options: [{
        id: 'a',
        image: 'i',
        title: 't',
        subtitle: 's',
        price: '$9',
        merchant: 'Amazon',
        url: 'https://x',
      }],
    }));
    const o = parsed?.options[0];
    expect(o?.description).toBe('s');
    expect(o?.fields?.Price).toBe('$9');
    expect(o?.fields?.Merchant).toBe('Amazon');
    expect(o?.url).toBe('https://x');
  });

  it('keeps the agent-supplied description over a stale subtitle', () => {
    const { parsed } = parseOptionList(JSON.stringify({
      options: [{
        id: 'a', image: 'i', title: 't',
        description: 'long form',
        subtitle: 'short stale',
      }],
    }));
    expect(parsed?.options[0].description).toBe('long form');
  });

  it('honors explicit fieldSchema in payload order', () => {
    const { parsed } = parseOptionList(JSON.stringify({
      fieldSchema: ['Price', 'Rating', 'Bedrooms'],
      options: [
        { id: 'a', image: 'i', title: 't', fields: { Price: '$120', Rating: '4.5★', Bedrooms: '2' } },
        { id: 'b', image: 'i', title: 't', fields: { Price: '$200', Bedrooms: '3' } }, // missing Rating
      ],
    }));
    expect(parsed?.fieldSchema).toEqual(['Price', 'Rating', 'Bedrooms']);
    expect(parsed?.options[1].fields?.Bedrooms).toBe('3');
    expect(parsed?.options[1].fields?.Rating).toBeUndefined();
  });

  it('leaves fieldSchema undefined when not declared (renderer takes union)', () => {
    const { parsed } = parseOptionList(JSON.stringify({
      options: [
        { id: 'a', image: 'i', title: 't', fields: { Price: '$1', Rating: '4★' } },
        { id: 'b', image: 'i', title: 't', fields: { Price: '$2' } },
      ],
    }));
    expect(parsed?.fieldSchema).toBeUndefined();
  });

  it('rejects non-string field values silently', () => {
    const { parsed } = parseOptionList(JSON.stringify({
      options: [{ id: 'a', image: 'i', title: 't', fields: { Price: '$1', Bad: null } }],
    }));
    expect(parsed?.options[0].fields?.Price).toBe('$1');
    expect(parsed?.options[0].fields?.Bad).toBeUndefined();
  });
});
