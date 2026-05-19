import fs from 'node:fs';
import path from 'node:path';

const MAX_DESCRIPTION_LENGTH = 180;
const DEFAULT_MAX_CHARS = 14_000;

interface SkillIndexEntry {
  id: string;
  source: 'user' | 'interaction' | 'domain';
  title: string;
  description: string;
}

export const SKILL_DISCOVERY_AND_LIFECYCLE_LINES = [
  'Use `agent-skill search` and `agent-skill view` to find relevant skills before inventing browser, site, or workflow-specific steps.',
  'After a task succeeds, create or patch a user skill only when the new procedure is likely to repeat, long-running enough to justify reuse, or generally applicable beyond the current session.',
  'Do not write skills for one-off facts/calculations, temporary page state, secrets/tokens, private account details, failed/speculative workflows, or content that belongs in the task output.',
];

/**
 * Provider-neutral nudge that the renderer can surface structured content
 * (plans, comparisons, multi-step explanations, diffs, status reports) as
 * sandboxed HTML artifacts via ```html fenced blocks. The renderer
 * extracts them and shows them in an iframe — static HTML + CSS only, no
 * JavaScript executes.
 *
 * Theme is injected so the agent picks palette colors that match the
 * current desktop app theme. The 'neobrutalist-html' interaction skill
 * defines the visual rules (borders/shadows/palette); this constant only
 * tells the agent the channel exists and what theme to target.
 */
/**
 * Active-palette summary the agent can paste verbatim. Kept in sync with
 * the 'neobrutalist-html' interaction skill — change them together.
 */
const ACTIVE_PALETTE = {
  light: {
    cardBg: '#f4ecd8',
    border: '#000',
    shadow: '#000',
    fg: '#000',
    accents: 'red #ff2b2b, blue #1a73ff, green #00c853, gold #ffd400',
  },
  dark: {
    cardBg: '#1c1c20',
    border: '#f4ecd8',
    shadow: '#f4ecd8',
    fg: '#f4ecd8',
    accents: 'red #ff5252, blue #4ea3ff, green #3ddc84, gold #ffd400',
  },
} as const;

export function htmlBlockGuidanceLines(theme: 'light' | 'dark' = 'dark'): string[] {
  const p = ACTIVE_PALETTE[theme];
  return [
    `UI THEME: ${theme}. When you emit a \`\`\`html block, use the active palette below. The full per-theme reference lives in the 'neobrutalist-html' interaction skill.`,
    `Active palette — card bg ${p.cardBg}, border ${p.border}, shadow ${p.shadow}, foreground ${p.fg}. Accents: ${p.accents}. Pick one bold accent + one secondary per artifact.`,
    'HTML blocks are an optional output channel — use them when layout helps the reader (plans, comparisons, status, timelines, diffs). Conversational replies, tool previews, and short answers should stay as plain markdown.',
    'When you emit an HTML block, keep it self-contained: inline styles or a single inline <style> tag are fine; do not reference external stylesheets, scripts, fonts, or images by URL — the sandbox blocks them.',
  ];
}

/** @deprecated kept for callers that have not yet adopted the theme-aware
 *  function form. Returns the dark-theme variant. */
export const HTML_BLOCK_GUIDANCE_LINES = htmlBlockGuidanceLines('dark');

function normalizeSlash(value: string): string {
  return value.split(path.sep).join('/');
}

function parseFrontmatter(content: string): { data: Record<string, string>; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { data: {}, body: content };
  const data: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (m) data[m[1]] = m[2].replace(/^['"]|['"]$/g, '').trim();
  }
  return { data, body: content.slice(match[0].length) };
}

function firstHeading(content: string): string {
  return content.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? '';
}

function firstParagraph(content: string): string {
  const { body } = parseFrontmatter(content);
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('---')) continue;
    return line.replace(/^[-*]\s+/, '').trim();
  }
  return '';
}

function titleize(slug: string): string {
  return slug
    .split(/[-_./]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function truncate(value: string, max = MAX_DESCRIPTION_LENGTH): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length > max ? `${compact.slice(0, max - 3)}...` : compact;
}

function scanFiles(dir: string, predicate: (abs: string) => boolean, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) scanFiles(abs, predicate, out);
    else if (entry.isFile() && predicate(abs)) out.push(abs);
  }
  return out;
}

function readEntry(file: string, source: SkillIndexEntry['source'], id: string): SkillIndexEntry {
  const content = fs.readFileSync(file, 'utf-8');
  const { data } = parseFrontmatter(content);
  const fallbackTitle = titleize(path.basename(file, path.extname(file)));
  return {
    id,
    source,
    title: String(data.name || firstHeading(content) || fallbackTitle),
    description: truncate(String(data.description || firstParagraph(content) || '')),
  };
}

export function scanSkillIndex(harnessDir: string): SkillIndexEntry[] {
  const entries: SkillIndexEntry[] = [];

  const userRoot = path.join(harnessDir, 'skills');
  for (const file of scanFiles(userRoot, (abs) => path.basename(abs) === 'SKILL.md')) {
    const relDir = normalizeSlash(path.relative(userRoot, path.dirname(file)));
    if (relDir && relDir !== '.') entries.push(readEntry(file, 'user', `user/${relDir}`));
  }

  const interactionRoot = path.join(harnessDir, 'interaction-skills');
  for (const file of scanFiles(interactionRoot, (abs) => abs.endsWith('.md'))) {
    const rel = normalizeSlash(path.relative(interactionRoot, file)).replace(/\.md$/i, '');
    entries.push(readEntry(file, 'interaction', `interaction/${rel}`));
  }

  const domainRoot = path.join(harnessDir, 'domain-skills');
  for (const file of scanFiles(domainRoot, (abs) => abs.endsWith('.md'))) {
    const rel = normalizeSlash(path.relative(domainRoot, file)).replace(/\.md$/i, '');
    entries.push(readEntry(file, 'domain', `domain/${rel}`));
  }

  const order = { user: 0, interaction: 1, domain: 2 };
  return entries.sort((a, b) => order[a.source] - order[b.source] || a.id.localeCompare(b.id));
}

function sectionTitle(source: SkillIndexEntry['source']): string {
  if (source === 'user') return 'User skills';
  if (source === 'interaction') return 'Interaction skills';
  return 'Domain skills';
}

export function buildSkillIndexPrompt(harnessDir: string, maxChars = DEFAULT_MAX_CHARS): string {
  let entries: SkillIndexEntry[];
  try {
    entries = scanSkillIndex(harnessDir);
  } catch {
    return '';
  }
  if (entries.length === 0) return '';

  const lines = [
    '## Available Skills',
    'Compact metadata index only. If a skill looks relevant, load full instructions with `agent-skill view <id>`. Use `agent-skill search "<query>"` when unsure.',
  ];
  let currentSource: SkillIndexEntry['source'] | null = null;
  let included = 0;

  for (const entry of entries) {
    const sectionLines = currentSource === entry.source ? [] : ['', `### ${sectionTitle(entry.source)}`];
    const label = entry.description && entry.description !== entry.title
      ? `- ${entry.id}: ${entry.title} - ${entry.description}`
      : `- ${entry.id}: ${entry.title}`;
    const next = [...sectionLines, label];
    const candidate = [...lines, ...next].join('\n');
    if (candidate.length > maxChars) break;
    lines.push(...next);
    currentSource = entry.source;
    included += 1;
  }

  if (included < entries.length) {
    lines.push('', `Index truncated: ${entries.length - included} more skills omitted. Run \`agent-skill search "<query>"\` for the full local index.`);
  }

  return lines.join('\n');
}
