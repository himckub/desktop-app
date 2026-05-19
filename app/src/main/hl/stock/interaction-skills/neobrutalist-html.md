# Neobrutalist HTML Output

How to emit ` ```html ` fenced blocks in the desktop chat that read as polished,
intentional artifacts. The renderer sandboxes every block (no JS, no external
resources), so everything you ship has to be self-contained.

This skill defines the **house style**. Use it whenever you'd reach for a plan,
comparison, status report, diff summary, timeline, or any structured layout
that markdown would flatten.

## When to use an HTML block

- Plans (multi-step, with status per step)
- Side-by-side comparisons (A vs B, before/after)
- Tables of trade-offs
- Status / health dashboards
- Diff or change summaries with context
- Timelines

## When NOT to use one

- Conversational answers ("here's how I did X")
- Code samples (markdown ```code``` is fine)
- Plain prose explanations
- Single-fact answers
- Anything where the reader doesn't benefit from layout

## Visual language — neobrutalism

The house style is **neobrutalist**: bold borders, hard shadows, no gradients,
no rounded corners. Layouts feel intentional and slightly raw rather than
smoothed. The renderer is dark by default; pick colors that pop against `#111`.

### Mandatory

- **2-3px solid black borders** on every card, button, badge, table cell, and
  block element. Use `border: 3px solid #000;` — not 1px, not "subtle."
- **Hard offset shadows**: `box-shadow: 4px 4px 0 #000;` (no blur, no spread).
  Bigger artifacts can go 6px or 8px. Never use soft `0 4px 12px rgba(...)`.
- **Square corners** — `border-radius: 0` everywhere. (Slight 4px radius is
  OK on chips but only if every chip uses the same value.)
- **High-contrast color palette** — bright primaries against off-white or
  dark backgrounds. The renderer is on a dark surface; lift artifacts to a
  cream/off-white background (`#f4ecd8`, `#fff4d6`, `#e6e6e6`) so they pop.

### Color palette (pick 1 background + 2-3 accents per artifact)

```
Backgrounds:    #f4ecd8 (cream)  #fff (white)  #fff4d6 (soft yellow)
Primary:        #ff2b2b (red)    #1a73ff (blue) #00c853 (green)
Accent:         #ffd400 (gold)   #ff7ec6 (pink) #9c27ff (purple)
Foreground:     #000 (always)
Muted text:     #555
```

Two-color rule: pick one **bold** accent and one **secondary** accent per
artifact. More than that and the bold-borders aesthetic turns into noise.

### Typography

- **Headlines**: sans-serif, bold (`font-weight: 800`), tight letter-spacing
  (`-0.02em`), large (24-32px). Examples: `Inter`, `Space Grotesk`,
  `IBM Plex Sans`. Never use Times-style serifs; never use Inter (house rule).
- **Body**: 14-15px, regular weight, line-height 1.5.
- **Mono / labels**: `IBM Plex Mono`, `JetBrains Mono`, `ui-monospace` for
  status chips, tags, timing labels.

You can't load external fonts (renderer blocks network). Use the system stack:
`-apple-system, "Segoe UI", system-ui, sans-serif` for headers/body and
`ui-monospace, SFMono-Regular, Menlo, monospace` for mono.

### Components

#### Card
```html
<div style="
  background:#f4ecd8;
  border:3px solid #000;
  box-shadow:6px 6px 0 #000;
  padding:18px 20px;
">…</div>
```

#### Button / chip
```html
<span style="
  display:inline-block;
  background:#ffd400;
  border:2px solid #000;
  padding:4px 10px;
  font-weight:700;
  box-shadow:3px 3px 0 #000;
  text-transform:uppercase;
  letter-spacing:0.04em;
  font-size:12px;
">DONE</span>
```

#### Status pill
```html
<span style="
  display:inline-block;
  background:#00c853;     /* swap: red #ff2b2b for fail, yellow #ffd400 for in-progress */
  color:#000;
  border:2px solid #000;
  padding:2px 8px;
  font-family:ui-monospace,monospace;
  font-size:11px;
  font-weight:700;
">✓ DONE</span>
```

#### Step list
```html
<ol style="list-style:none;padding:0;margin:0;">
  <li style="display:flex;align-items:center;gap:12px;border-bottom:2px solid #000;padding:10px 0;">
    <span style="background:#1a73ff;color:#fff;border:2px solid #000;width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;font-weight:800;">1</span>
    <span style="flex:1">Inventory call sites</span>
    <span style="background:#00c853;border:2px solid #000;padding:2px 8px;font-family:ui-monospace,monospace;font-size:11px;font-weight:700;">DONE</span>
  </li>
  <!-- repeat -->
</ol>
```

#### Comparison (2-up)
```html
<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
  <div style="background:#fff4d6;border:3px solid #000;box-shadow:5px 5px 0 #000;padding:14px;">
    <h3 style="margin:0 0 6px;font-size:18px;font-weight:800;letter-spacing:-0.01em;">Option A</h3>
    <p style="margin:0 0 6px;">Fast. Simple.</p>
    <span style="background:#ff2b2b;color:#fff;border:2px solid #000;padding:2px 8px;font-family:ui-monospace,monospace;font-size:11px;font-weight:700;">RISKY</span>
  </div>
  <div style="background:#f4ecd8;border:3px solid #000;box-shadow:5px 5px 0 #000;padding:14px;">
    <h3 style="margin:0 0 6px;font-size:18px;font-weight:800;letter-spacing:-0.01em;">Option B</h3>
    <p style="margin:0 0 6px;">Slower. Safer.</p>
    <span style="background:#00c853;border:2px solid #000;padding:2px 8px;font-family:ui-monospace,monospace;font-size:11px;font-weight:700;">SAFE</span>
  </div>
</div>
```

#### Table
```html
<table style="width:100%;border-collapse:collapse;background:#fff;border:3px solid #000;">
  <thead>
    <tr style="background:#000;color:#fff;">
      <th style="padding:8px 10px;text-align:left;border-right:2px solid #fff;text-transform:uppercase;letter-spacing:0.06em;font-size:11px;">Engine</th>
      <th style="padding:8px 10px;text-align:left;text-transform:uppercase;letter-spacing:0.06em;font-size:11px;">Notes</th>
    </tr>
  </thead>
  <tbody>
    <tr style="border-bottom:2px solid #000;"><td style="padding:8px 10px;border-right:2px solid #000;font-weight:700;">claude-code</td><td style="padding:8px 10px;">…</td></tr>
  </tbody>
</table>
```

## A reference artifact

Copy this as the starting point when you need a plan. Replace the items.

```html
<div style="
  background:#f4ecd8;
  border:3px solid #000;
  box-shadow:6px 6px 0 #000;
  padding:20px 22px;
  font-family:-apple-system,'Segoe UI',system-ui,sans-serif;
  color:#000;
  font-size:14px;
  line-height:1.5;
">
  <div style="display:flex;align-items:center;gap:10px;margin:0 0 14px;">
    <h2 style="margin:0;font-size:22px;font-weight:800;letter-spacing:-0.02em;">Refactor pass</h2>
    <span style="background:#ffd400;border:2px solid #000;padding:2px 8px;font-family:ui-monospace,monospace;font-size:11px;font-weight:700;">3 STEPS</span>
  </div>
  <ol style="list-style:none;padding:0;margin:0;">
    <li style="display:flex;align-items:center;gap:12px;border-top:2px solid #000;padding:10px 0;">
      <span style="background:#1a73ff;color:#fff;border:2px solid #000;width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;font-weight:800;">1</span>
      <span style="flex:1;">Inventory call sites</span>
      <span style="background:#00c853;border:2px solid #000;padding:2px 8px;font-family:ui-monospace,monospace;font-size:11px;font-weight:700;">DONE</span>
    </li>
    <li style="display:flex;align-items:center;gap:12px;border-top:2px solid #000;padding:10px 0;">
      <span style="background:#1a73ff;color:#fff;border:2px solid #000;width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;font-weight:800;">2</span>
      <span style="flex:1;">Replace one at a time</span>
      <span style="background:#ffd400;border:2px solid #000;padding:2px 8px;font-family:ui-monospace,monospace;font-size:11px;font-weight:700;">IN PROGRESS</span>
    </li>
    <li style="display:flex;align-items:center;gap:12px;border-top:2px solid #000;border-bottom:2px solid #000;padding:10px 0;">
      <span style="background:#1a73ff;color:#fff;border:2px solid #000;width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;font-weight:800;">3</span>
      <span style="flex:1;">Run the integration suite</span>
      <span style="background:#fff;border:2px solid #000;padding:2px 8px;font-family:ui-monospace,monospace;font-size:11px;font-weight:700;">PENDING</span>
    </li>
  </ol>
</div>
```

## Hard rules — never violate

- **Never** `border-radius: 12px` or anything pillow-y. Square (or near-square)
  corners only.
- **Never** soft shadow (`0 4px 12px rgba(0,0,0,.15)`). Use offset solid black.
- **Never** linear-gradient backgrounds. Flat fills only.
- **Never** rely on JavaScript or external assets — the sandbox blocks both.
- **Never** use Inter (house rule). Use the system sans stack.
- **Never** add a left-edge accent stripe to a card (house rule).
- **Never** use the sparkles ✨ icon (house rule).

## Sanity check before emitting

- Did I use `border: 3px solid #000` somewhere visible?
- Are the shadows hard offset (no blur)?
- Are corners square (`border-radius: 0`)?
- Does the artifact stand on its own — no scripts, no external URLs?
- Would removing every style still leave readable semantic HTML?

If yes to all five, ship it.
