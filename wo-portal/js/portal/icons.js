// ---------------------------------------------------------------------------
// Icons — Lucide, inlined.
//
// **The portal uses Lucide and nothing else.** Not emoji (a different shape,
// weight and colour on every platform, and grey on one OS is not grey on the
// next), not a webfont, not an icon package. Lucide's shapes are plain SVG
// paths, so the way to "install" one is to copy its path data in here — which
// keeps the runtime dependency count at zero and the CSP at `script-src 'self'`.
//
// Adding one: find it at lucide.dev, copy the children of its <svg>, and add an
// entry below. Everything else — the 24×24 box, the 2px round stroke,
// currentColor, aria-hidden — is shared, so an icon can never arrive wearing a
// different weight from its neighbours.
//
// SVG needs createElementNS; ui.js's el() builds HTML elements and cannot make
// these. That is the whole reason this file exists rather than a few more
// entries in ui.js.
// ---------------------------------------------------------------------------

const NS = 'http://www.w3.org/2000/svg';

/** Each icon is its Lucide shapes, as [tag, attributes]. Kept in Lucide's own
 *  order so a diff against the source is a straight read. */
const ICONS = {
  // lucide.dev/icons/plus
  plus: [
    ['path', { d: 'M5 12h14' }],
    ['path', { d: 'M12 5v14' }],
  ],
  // lucide.dev/icons/refresh-cw — pull the latest version of the board
  'refresh-cw': [
    ['path', { d: 'M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8' }],
    ['path', { d: 'M21 3v5h-5' }],
    ['path', { d: 'M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16' }],
    ['path', { d: 'M8 16H3v5' }],
  ],
  // lucide.dev/icons/maximize — take the board full screen
  maximize: [
    ['path', { d: 'M8 3H5a2 2 0 0 0-2 2v3' }],
    ['path', { d: 'M21 8V5a2 2 0 0 0-2-2h-3' }],
    ['path', { d: 'M3 16v3a2 2 0 0 0 2 2h3' }],
    ['path', { d: 'M16 21h3a2 2 0 0 0 2-2v-3' }],
  ],
  // lucide.dev/icons/minimize — and give the page back
  minimize: [
    ['path', { d: 'M8 3v3a2 2 0 0 1-2 2H3' }],
    ['path', { d: 'M21 8h-3a2 2 0 0 1-2-2V3' }],
    ['path', { d: 'M3 16h3a2 2 0 0 1 2 2v3' }],
    ['path', { d: 'M16 21v-3a2 2 0 0 1 2-2h3' }],
  ],
  // lucide.dev/icons/presentation — a whiteboard on its stand
  presentation: [
    ['path', { d: 'M2 3h20' }],
    ['path', { d: 'M21 3v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V3' }],
    ['path', { d: 'm7 21 5-5 5 5' }],
  ],
  // lucide.dev/icons/square-kanban — a board, in the shape of its columns
  'square-kanban': [
    ['rect', { width: '18', height: '18', x: '3', y: '3', rx: '2' }],
    ['path', { d: 'M8 7v7' }],
    ['path', { d: 'M12 7v9' }],
    ['path', { d: 'M16 7v5' }],
  ],
  // lucide.dev/icons/square-pen — writing something down
  'square-pen': [
    ['path', { d: 'M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7' }],
    ['path', { d: 'M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z' }],
  ],
  // lucide.dev/icons/check — the Done editing button on a whiteboard
  check: [
    ['path', { d: 'M20 6 9 17l-5-5' }],
  ],
  // lucide.dev/icons/timer — a stopwatch, for the billable clock
  timer: [
    ['line', { x1: '10', x2: '14', y1: '2', y2: '2' }],
    ['line', { x1: '12', x2: '15', y1: '14', y2: '11' }],
    ['circle', { cx: '12', cy: '14', r: '8' }],
  ],
  // lucide.dev/icons/compass — a bearing, for the verse of the week
  compass: [
    ['path', { d: 'm16.24 7.76-1.804 5.411a2 2 0 0 1-1.265 1.265L7.76 16.24l1.804-5.411a2 2 0 0 1 1.265-1.265z' }],
    ['circle', { cx: '12', cy: '12', r: '10' }],
  ],
  // lucide.dev/icons/external-link — leaves this origin
  'external-link': [
    ['path', { d: 'M15 3h6v6' }],
    ['path', { d: 'M10 14 21 3' }],
    ['path', { d: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6' }],
  ],
  // lucide.dev/icons/mail — the team panel's email action
  mail: [
    ['path', { d: 'm22 7-8.991 5.727a2 2 0 0 1-2.009 0L2 7' }],
    ['rect', { x: '2', y: '4', width: '20', height: '16', rx: '2' }],
  ],
  // lucide.dev/icons/phone — call somebody
  phone: [
    ['path', { d: 'M13.832 16.568a1 1 0 0 0 1.213-.303l.355-.465A2 2 0 0 1 17 15h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2A18 18 0 0 1 2 4a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v3a2 2 0 0 1-.8 1.6l-.468.351a1 1 0 0 0-.292 1.233 14 14 0 0 0 6.392 6.384' }],
  ],
  // lucide.dev/icons/message-square — a text, or a message inside the portal
  'message-square': [
    ['path', { d: 'M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z' }],
  ],
  // lucide.dev/icons/smile-plus — add a reaction. The button is the icon; the
  // emoji it puts on a message are content, not icons (see emoji.js).
  'smile-plus': [
    ['path', { d: 'M22 11v1a10 10 0 1 1-9-10' }],
    ['path', { d: 'M8 14s1.5 2 4 2 4-2 4-2' }],
    ['line', { x1: '9', x2: '9.01', y1: '9', y2: '9' }],
    ['line', { x1: '15', x2: '15.01', y1: '9', y2: '9' }],
    ['path', { d: 'M16 5h6' }],
    ['path', { d: 'M19 2v6' }],
  ],
  // lucide.dev/icons/download — a copy to keep, on the signing page and beside
  // a document waiting for a signature
  download: [
    ['path', { d: 'M12 15V3' }],
    ['path', { d: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4' }],
    ['path', { d: 'm7 10 5 5 5-5' }],
  ],
  // lucide.dev/icons/file-pen-line — a document waiting to be signed
  'file-pen-line': [
    ['path', { d: 'm18 5-2.414-2.414A2 2 0 0 0 14.172 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5' }],
    ['path', { d: 'M21.378 12.626a1 1 0 0 0-3.004-3.004l-4.01 4.012a2 2 0 0 0-.506.854l-.837 2.87a.5.5 0 0 0 .62.62l2.87-.837a2 2 0 0 0 .854-.506z' }],
    ['path', { d: 'M8 18h1' }],
  ],
  // lucide.dev/icons/circle-check-big — read to the end, and signed
  'circle-check-big': [
    ['path', { d: 'M21.801 10A10 10 0 1 1 17 3.335' }],
    ['path', { d: 'm9 11 3 3L22 4' }],
  ],
  // lucide.dev/icons/grip-vertical — the grab bar on a reorderable row
  // (js/portal/reorder.js). Six dots, drawn as r=1 circles: at 2px of stroke
  // they read as solid, which is what the shape is supposed to look like.
  'grip-vertical': [
    ['circle', { cx: '9', cy: '12', r: '1' }],
    ['circle', { cx: '9', cy: '5', r: '1' }],
    ['circle', { cx: '9', cy: '19', r: '1' }],
    ['circle', { cx: '15', cy: '12', r: '1' }],
    ['circle', { cx: '15', cy: '5', r: '1' }],
    ['circle', { cx: '15', cy: '19', r: '1' }],
  ],

  // lucide.dev/icons/x — the close control on every dialog in the portal.
  // Was a literal U+00D7, the multiplication sign, which Inter draws as a
  // thin mathematical operator rather than a close button.
  x: [
    ['path', { d: 'M18 6 6 18' }],
    ['path', { d: 'm6 6 12 12' }],
  ],

  // lucide.dev/icons/square-check — a ticked box, for a card's checklist
  // count. Replaces a literal ☑ (U+2611), which is a different shape, weight
  // and colour on every platform and on several of them a colour emoji.
  'square-check': [
    ['rect', { width: '18', height: '18', x: '3', y: '3', rx: '2' }],
    ['path', { d: 'm9 12 2 2 4-4' }],
  ],

  // lucide.dev/icons/square — the same box unticked: an open task's checkbox.
  // The rect matches square-check's exactly, so ticking one never shifts it.
  square: [
    ['rect', { width: '18', height: '18', x: '3', y: '3', rx: '2' }],
  ],

  // lucide.dev/icons/heart — the like button on a project comment. The chip
  // fills it via CSS when the like is yours; the shape never changes.
  heart: [
    ['path', { d: 'M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z' }],
  ],

  // lucide.dev/icons/star — the Focus star: "this is what I am on now"
  // (focus.js). The same shape njdboards draws on a focused card.
  star: [
    ['path', { d: 'M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z' }],
  ],

  // lucide.dev/icons/car — "Log a drive" on the quick-add button. The drive
  // tracker is the one thing in the portal you reach for while holding a set
  // of keys, so it earns a place beside the thumb.
  car: [
    ['path', { d: 'M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9A3.7 3.7 0 0 0 2 12v4c0 .6.4 1 1 1h2' }],
    ['circle', { cx: '7', cy: '17', r: '2' }],
    ['path', { d: 'M9 17h6' }],
    ['circle', { cx: '17', cy: '17', r: '2' }],
  ],

  // lucide.dev/icons/receipt — "Log an expense" on the quick-add button.
  receipt: [
    ['path', { d: 'M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z' }],
    ['path', { d: 'M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8' }],
    ['path', { d: 'M12 17.5v-11' }],
  ],

  // lucide.dev/icons/smartphone — the "add this to your home screen" hint
  // (install-hint.js). The portal has been installable since it shipped and
  // iOS never says so; this is the only place that shape is needed.
  smartphone: [
    ['rect', { width: '14', height: '20', x: '5', y: '2', rx: '2', ry: '2' }],
    ['path', { d: 'M12 18h.01' }],
  ],

  // lucide.dev/icons/sparkles — the AI rewrite button (ai-rewrite.js)
  sparkles: [
    ['path', { d: 'M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z' }],
    ['path', { d: 'M20 3v4' }],
    ['path', { d: 'M22 5h-4' }],
    ['path', { d: 'M4 17v2' }],
    ['path', { d: 'M5 18H3' }],
  ],
};

/**
 * One icon, as an <svg> ready to append.
 *
 * Decorative by default: `aria-hidden`, because every icon in this portal sits
 * beside its own label. An icon that is genuinely the only thing in a control
 * needs a label on the control, not here.
 */
export function icon(name, { size = 18, className = '' } = {}) {
  const shapes = ICONS[name];
  if (!shapes) throw new Error(`No such icon: ${name}. Add it from lucide.dev.`);

  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  if (className) svg.setAttribute('class', className);

  for (const [tag, attrs] of shapes) {
    const shape = document.createElementNS(NS, tag);
    for (const [key, value] of Object.entries(attrs)) shape.setAttribute(key, value);
    svg.append(shape);
  }

  return svg;
}

/** The names this module can draw — the guard in the test that stops a caller
 *  asking for one that was never added. */
export const ICON_NAMES = Object.keys(ICONS);
