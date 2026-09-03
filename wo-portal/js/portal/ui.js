// ---------------------------------------------------------------------------
// DOM helpers, toasts, and modal forms
//
// Everything user-supplied goes through textContent, never innerHTML — client
// names, card titles and messages are untrusted input even when they come from
// people we like.
// ---------------------------------------------------------------------------

// SVG needs createElementNS, which el() cannot do — hence a separate module.
// icons.js imports nothing, so this direction is safe.
import { icon } from './icons.js';

/**
 * el('p', { class: 'x', onclick: fn }, ['text', childNode])
 * Props: `class`, `text`, `dataset`, `on<event>` handlers, `value`, plus any
 * attribute. Booleans set/skip the attribute; null and undefined are skipped.
 */
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);

  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;

    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'value') node.value = value;
    else if (key === 'checked') node.checked = Boolean(value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }

  for (const child of Array.isArray(children) ? children : [children]) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }

  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function mount(node, ...children) {
  clear(node);
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function byId(id) {
  return document.getElementById(id);
}

// Toasts
// ---------------------------------------------------------------------------

function toastStack() {
  let stack = byId('toast-stack');
  if (!stack) {
    stack = el('div', { class: 'toast-stack', id: 'toast-stack', 'aria-live': 'polite' });
    document.body.append(stack);
  }
  return stack;
}

export function toast(message, kind = '') {
  const node = el('div', {
    class: kind ? `toast toast--${kind}` : 'toast',
    role: kind === 'error' ? 'alert' : 'status',
    text: message,
  });
  toastStack().append(node);
  window.setTimeout(() => node.remove(), kind === 'error' ? 7000 : 4000);
}

// Async controls
// ---------------------------------------------------------------------------

/**
 * Wrap a click handler that writes to the database so it cannot run twice.
 *
 * formModal's submit already disables itself for the round trip. Buttons built
 * by hand mostly did not, and the portal writes to a live database over a
 * connection that is sometimes a phone on a site visit: a second press while
 * the first request is in flight deletes a payment twice, or stops a timer
 * that is already stopped, and the second failure is the one the person sees.
 *
 * The button comes off the event rather than being passed in, so an existing
 * `onclick: async () => {…}` becomes `onclick: busy(async () => {…})` with
 * nothing else moved. It is read synchronously because `currentTarget` is
 * nulled the moment dispatch finishes, which is before the first await
 * resolves.
 *
 * `label` swaps the caption while it runs. Leave it off where the button's
 * text is data rather than a verb.
 */
export function busy(run, { label } = {}) {
  let running = false;

  return async function guarded(event) {
    if (running) return undefined;
    const button = event && event.currentTarget;
    const previousLabel = button ? button.textContent : null;

    running = true;
    if (button) {
      button.disabled = true;
      if (label) button.textContent = label;
    }

    try {
      return await run(event);
    } finally {
      running = false;
      // A handler that succeeded has usually closed its dialog or re-rendered
      // the row this button was in. Putting a caption back on a node nobody
      // can see is harmless; putting one back on a node that was replaced is
      // impossible, so only touch it while it is still in the document.
      if (button && button.isConnected) {
        button.disabled = false;
        if (label) button.textContent = previousLabel;
      }
    }
  };
}

// Clipboard
// ---------------------------------------------------------------------------

/**
 * Put formatted text on the clipboard, so a paste into a Gmail compose window
 * arrives laid out rather than as a wall of markup.
 *
 * The text/plain half is not optional. It is what a plain-text destination
 * receives, and a rich write without it pastes as nothing at all.
 *
 * Two tiers, because the modern API is neither always present nor always
 * permitted:
 *
 *   1. navigator.clipboard.write(), both flavours in one ClipboardItem.
 *   2. A copy event, intercepted. The offscreen node holds the PLAIN text —
 *      execCommand('copy') refuses an empty selection, so something has to be
 *      selected — and the handler then overwrites both flavours before the
 *      browser reads them. Deprecated, and still the only path that works in a
 *      few ordinary places (older Firefox, some embedded webviews).
 *
 * Tier 2 is why this does not touch innerHTML: the markup goes to the
 * clipboard through setData, never through the DOM, so the house rule holds
 * here as everywhere else.
 *
 * Resolves true when something reached the clipboard, false when the caller
 * should fall back to asking the user to copy by hand.
 */
export async function copyRichText({ html, text }) {
  const markup = String(html == null ? '' : html);
  const plain = String(text == null ? '' : text);
  if (!markup && !plain) return false;

  if (window.ClipboardItem && navigator.clipboard && navigator.clipboard.write) {
    try {
      await navigator.clipboard.write([
        new window.ClipboardItem({
          'text/html': new Blob([markup], { type: 'text/html' }),
          'text/plain': new Blob([plain], { type: 'text/plain' }),
        }),
      ]);
      return true;
    } catch {
      // Refused, or the document was not focused. Fall through rather than
      // fail: tier 2 clears both of those bars.
    }
  }

  // Positioned offscreen, not hidden: display:none and visibility:hidden are
  // both unselectable, and an unselectable node copies nothing.
  const holder = el('div', { text: plain });
  holder.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;'
    + 'white-space:pre-wrap;pointer-events:none';
  document.body.append(holder);

  const selection = window.getSelection();
  const previous = selection && selection.rangeCount ? selection.getRangeAt(0) : null;
  const range = document.createRange();
  range.selectNodeContents(holder);
  selection.removeAllRanges();
  selection.addRange(range);

  const onCopy = (event) => {
    event.preventDefault();
    event.clipboardData.setData('text/html', markup);
    event.clipboardData.setData('text/plain', plain);
  };

  let copied = false;
  document.addEventListener('copy', onCopy);
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  } finally {
    document.removeEventListener('copy', onCopy);
    selection.removeAllRanges();
    if (previous) selection.addRange(previous);
    holder.remove();
  }

  return copied;
}

// Formatting
// ---------------------------------------------------------------------------

const DATE_FMT = new Intl.DateTimeFormat('en-US', {
  month: 'short', day: 'numeric', year: 'numeric',
});

const TIME_FMT = new Intl.DateTimeFormat('en-US', {
  month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
});

/** Date-only columns are plain YYYY-MM-DD; parsing them as UTC would shift
 *  the displayed day for anyone west of Greenwich, so split them by hand. */
export function fmtDate(value) {
  if (!value) return '';
  const parts = String(value).slice(0, 10).split('-');
  if (parts.length !== 3) return '';
  return DATE_FMT.format(new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])));
}

export function fmtDateTime(value) {
  if (!value) return '';
  return TIME_FMT.format(new Date(value));
}

export function fmtBytes(bytes) {
  if (!bytes && bytes !== 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = Number(bytes);
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size < 10 && unit > 0 ? size.toFixed(1) : Math.round(size)} ${units[unit]}`;
}

export function isOverdue(dateValue) {
  if (!dateValue) return false;
  const today = new Date();
  const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  return String(dateValue).slice(0, 10) < iso;
}

export function titleCase(value) {
  return String(value || '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// Progress bar
// ---------------------------------------------------------------------------

export function progressBar(done, total, labelOverride, ariaLabel) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const bar = el('div', { class: 'progress__bar' });
  bar.style.width = `${pct}%`;

  return el('div', {
    class: 'progress',
    role: 'progressbar',
    'aria-valuenow': String(pct),
    'aria-valuemin': '0',
    'aria-valuemax': '100',
    'aria-label': ariaLabel || 'Project progress',
  }, [
    el('div', { class: 'progress__track' }, [bar]),
    el('p', {
      class: 'progress__label',
      // "Reached" rather than "complete" — these are points on a journey, and
      // the bar beside it already carries the percentage.
      text: labelOverride || (total > 0
        ? `${done} of ${total} waypoints reached`
        : 'No waypoints yet'),
    }),
  ]);
}

// Modals
// ---------------------------------------------------------------------------

/* A dialog that scroll-chains to the page behind it is the worst thing this UI
 * does on a phone: you flick upward to reach Save, iOS decides the document
 * under the overlay is the thing you meant to scroll, and the form does not
 * move. Locking <body> while a dialog is up stops that.
 *
 * Modals stack — the journey picker opens over the project page and a form can
 * open from inside one — so the lock is counted rather than toggled, and only
 * the last dialog out puts back whatever was there before. Setting it through
 * .style is CSSOM, not an inline style attribute, so style-src without
 * 'unsafe-inline' is untroubled by it. */
let openModals = 0;
let overflowBeforeLock = '';

function lockBodyScroll() {
  if (openModals === 0) overflowBeforeLock = document.body.style.overflow;
  openModals += 1;
  document.body.style.overflow = 'hidden';
}

function unlockBodyScroll() {
  if (openModals === 0) return;
  openModals -= 1;
  if (openModals === 0) document.body.style.overflow = overflowBeforeLock;
}

/* Which dialogs are open, innermost last.
 *
 * Modals stack, and every shell used to put its own Escape handler on
 * `document` — so one Escape closed the picker AND the project page's dialog
 * underneath it, because both handlers heard the same key. The keyboard
 * belongs to the top of the stack and nothing else, and the same is true of
 * the focus trap: trapping in two dialogs at once traps in neither. */
const modalStack = [];

/* aria-labelledby needs an id, dialogs stack, and two elements with the same
 * id make the attribute point at whichever the browser saw first. */
let dialogSeq = 0;

/* Everything that can hold focus, minus the things that cannot hold it *now*.
 * Read fresh on every Tab rather than cached at open: a dialog's contents
 * change constantly — the journey picker fills a list, formModal hides and
 * shows its error line, the paperwork wizard swaps whole panes — and a cached
 * list would trap focus against elements that are no longer there. */
const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled])',
  'select:not([disabled])', 'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function focusableIn(root) {
  return [...root.querySelectorAll(FOCUSABLE)].filter((node) => {
    if (node.hidden || node.closest('[hidden]')) return false;
    const rect = node.getBoundingClientRect();
    return rect.width > 0 || rect.height > 0;
  });
}

/**
 * Everything a dialog has to do with the keyboard and with focus, in one
 * place: the counted scroll lock, Escape, the Tab trap, the opening focus and
 * the focus put back on the way out.
 *
 * modalShell is the usual way to get this. It is exported because the ledger's
 * journal-entry dialog is built by hand — it needs a growing list of lines and
 * a running total, which a fixed field list cannot do — and a second dialog
 * implementation is exactly how a second set of keyboard bugs happens. It had
 * them: no role, no label, no trap, no focus restored, and a raw
 * `body.style.overflow` that unlocked the page out from under any dialog still
 * open above it.
 *
 * Call open() once the overlay is in the document, release() as it comes out.
 * `dialog` must be the panel itself, not the backdrop — it is what focus is
 * trapped inside and what gets focused on entry.
 */
export function dialogBehaviour({ dialog, onEscape }) {
  const previousFocus = document.activeElement;
  const api = {};
  let live = false;

  function onKeydown(event) {
    // Only the innermost dialog owns the keyboard. Without this, one Escape
    // closes the picker AND the dialog underneath that opened it.
    if (modalStack[modalStack.length - 1] !== api) return;

    if (event.key === 'Escape') {
      if (onEscape) onEscape();
      return;
    }
    if (event.key !== 'Tab') return;

    /* The trap. Without it Tab walks straight out of the dialog and into the
     * page behind — which `aria-modal` has just told a screen reader is not
     * there, so the reader goes silent on elements the keyboard is visiting. */
    const stops = focusableIn(dialog);
    if (!stops.length) {
      event.preventDefault();
      dialog.focus();
      return;
    }

    const first = stops[0];
    const last = stops[stops.length - 1];
    const active = document.activeElement;

    if (event.shiftKey && (active === first || !dialog.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  }

  api.open = function open() {
    if (live) return;
    live = true;
    modalStack.push(api);
    document.addEventListener('keydown', onKeydown);
    lockBodyScroll();
    // Focus the container rather than the first control: it is what makes the
    // dialog announce itself and its title on entry, and unlike focusing an
    // input it does not throw a soft keyboard over a dialog nobody has read
    // yet. Callers that want a specific control focused do that after open()
    // and win, because they run last.
    dialog.focus();
  };

  api.release = function release() {
    if (!live) return;
    live = false;
    unlockBodyScroll();
    document.removeEventListener('keydown', onKeydown);
    const at = modalStack.indexOf(api);
    if (at !== -1) modalStack.splice(at, 1);
    // A trigger that was re-rendered while the dialog was up is no longer in
    // the document, and focusing a detached node silently drops focus to
    // <body> — which sends the next Tab back to the top of the page. Only
    // restore to something still there.
    if (previousFocus && previousFocus.isConnected && previousFocus.focus) previousFocus.focus();
  };

  return api;
}

/**
 * The shared modal chrome: overlay, dialog, close button, Escape, backdrop
 * click, a focus trap, and focus restored to whatever opened it.
 *
 * Both formModal and the journey picker sit on this, so the keyboard and focus
 * behaviour can only ever be right or wrong in one place.
 *
 * Returns { overlay, body, foot, close, showError }. Call close(result) to
 * dismiss; the caller's own resolve is wired through onClose.
 */
export function modalShell({ title, onClose }) {
  const errorLine = el('p', { class: 'notice notice--error', role: 'alert', hidden: true });

  const body = el('div', { class: 'modal__body' }, [errorLine]);
  const foot = el('div', { class: 'modal__foot' });

  dialogSeq += 1;
  const titleId = `modal-title-${dialogSeq}`;

  // body and foot go in here directly. A caller that needs them inside a
  // <form> — formModal does — appends them to the form instead, which moves
  // them; a caller that doesn't gets a working dialog with no extra step.
  const dialog = el('div', {
    class: 'modal__dialog',
    role: 'dialog',
    'aria-modal': 'true',
    // Without this the dialog announces as "dialog" and nothing else — the
    // heading is right there on screen and is not what gets read on entry.
    'aria-labelledby': titleId,
    // Focus has to land inside the dialog for `aria-modal` to mean anything,
    // and the container is the one target that is always present and never
    // pops a soft keyboard. -1 keeps it out of the Tab order.
    tabindex: '-1',
  }, [
    el('div', { class: 'modal__head' }, [
      el('h2', { id: titleId, text: title }),
      el('button', {
        class: 'modal__close',
        type: 'button',
        'aria-label': 'Close',
        onclick: () => close(null),
      }, [icon('x', { size: 18 })]),
    ]),
    body,
    foot,
  ]);

  const overlay = el('div', {
    class: 'modal',
    onclick: (event) => { if (event.target === overlay) close(null); },
  }, [dialog]);

  const behaviour = dialogBehaviour({ dialog, onEscape: () => close(null) });

  function showError(error) {
    errorLine.hidden = false;
    errorLine.textContent = error && error.message ? error.message : String(error);

    // The dialog is its own scroller (max-height: 90vh; overflow-y: auto) and
    // this line is its first child. On a form longer than the viewport — the
    // client form has 22 fields — you press Save at the bottom, the server
    // refuses, and from where you are sitting nothing happens: the button
    // flickers back from "Saving…" and the reason is 900px above your thumb.
    // The required-field path never had this problem because it calls focus(),
    // which scrolls; the thrown-error path is every real server failure.
    errorLine.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function clearError() {
    errorLine.hidden = true;
  }

  // Escape and a backdrop click can both land before the first close finishes,
  // and formModal's delete path closes a dialog the caller may close again.
  // The scroll lock is counted, so a double close would leak a decrement.
  let isOpen = false;

  function close(result) {
    if (!isOpen) return;
    isOpen = false;
    behaviour.release();
    overlay.remove();
    if (onClose) onClose(result);
  }

  function open() {
    if (isOpen) return;
    isOpen = true;
    // In the document before open(), so the focus it moves lands on a node
    // that is actually rendered.
    document.body.append(overlay);
    behaviour.open();
  }

  return { overlay, dialog, body, foot, open, close, showError, clearError };
}

// Confirmations
// ---------------------------------------------------------------------------
//
// There were 25 window.confirm() calls in this portal, every one of which
// dropped the product into an OS alert captioned with the bare domain and
// says:". The copy inside them was good — it named consequences, it was
// written in the house voice — and it was being rendered in the one container
// that makes it look like a browser security warning. One of them was the
// client's Approve button.
//
// This lives beside modalShell rather than in a module of its own because it
// is the same tier of thing: formModal needs it for its delete button, and a
// base module importing from one built on top of it is a cycle waiting to
// misbehave.
//
// Deliberate differences from window.confirm, each of which is the reason it
// exists rather than an embellishment:
//
//   * The confirm button says what it does. "OK" is not an answer to
//     "Delete this client?" — "Delete client" is. Callers pass the verb.
//   * A destructive confirm opens with the cancel button focused. Return
//     pressed reflexively on a dialog that appeared under your finger should
//     not delete a client's record.
//   * The destructive action is separated from the safe one rather than
//     sitting flush beside it, using the same margin-left: auto idiom
//     .modal__foot .btn--danger already uses.
//   * Escape, the backdrop, the close button and Cancel all resolve false.
//     There is exactly one way to get true.
// ---------------------------------------------------------------------------

/**
 * Works out the dialog's shape from the caller's options.
 *
 * Split out from the DOM work because this is the part with branching in it,
 * and this repo tests logic rather than rendering — see tools/portal/*.test.mjs.
 *
 * @returns {{
 *   title: string, paragraphs: string[], confirmLabel: string,
 *   cancelLabel: string, danger: boolean, focus: 'confirm'|'cancel'
 * }}
 */
export function confirmPlan({
  title,
  body,
  confirmLabel,
  cancelLabel,
  tone,
} = {}) {
  const danger = tone === 'danger';

  // A string is one paragraph; an array is several. Blank entries are dropped
  // so a caller can build the list conditionally without guarding each line.
  const paragraphs = (Array.isArray(body) ? body : [body])
    .map((line) => (typeof line === 'string' ? line.trim() : ''))
    .filter(Boolean);

  return {
    title: (typeof title === 'string' && title.trim()) || 'Are you sure?',
    paragraphs,
    // No default verb for a destructive action. "Delete" as a fallback label
    // on a dialog whose caller forgot to say what it deletes is precisely the
    // failure this module exists to stop, so the neutral word is the default
    // and callers are expected to be specific.
    confirmLabel: (typeof confirmLabel === 'string' && confirmLabel.trim()) || 'Continue',
    cancelLabel: (typeof cancelLabel === 'string' && cancelLabel.trim()) || 'Cancel',
    danger,
    focus: danger ? 'cancel' : 'confirm',
  };
}

/**
 * Ask, and resolve true only if the person said yes.
 *
 * @param {object} options
 * @param {string} options.title         The question, as a sentence.
 * @param {string|string[]} options.body What happens if they say yes.
 * @param {string} options.confirmLabel  The verb. "Delete client", not "OK".
 * @param {string} [options.cancelLabel] Defaults to "Cancel".
 * @param {'default'|'danger'} [options.tone]
 * @returns {Promise<boolean>}
 */
export function confirmModal(options = {}) {
  const plan = confirmPlan(options);

  return new Promise((resolve) => {
    let settled = false;
    const settle = (answer) => {
      if (settled) return;
      settled = true;
      resolve(answer);
    };

    // Escape, the backdrop and the × all arrive here with null. Anything that
    // is not an explicit yes is a no.
    const shell = modalShell({
      title: plan.title,
      onClose: (result) => settle(result === true),
    });

    // append, not mount: mount() clears the node first, and shell.body already
    // holds the shared error line that showError() writes into. Wiping it here
    // would leave that function setting text on a detached node.
    shell.body.append(...plan.paragraphs.map((text) => el('p', { text })));

    const cancel = el('button', {
      class: 'btn btn--ghost',
      type: 'button',
      text: plan.cancelLabel,
      onclick: () => shell.close(false),
    });

    const confirm = el('button', {
      class: plan.danger ? 'btn btn--danger' : 'btn',
      type: 'button',
      text: plan.confirmLabel,
      onclick: () => shell.close(true),
    });

    // Cancel first in the DOM, so it is first in the tab order and first under
    // a thumb reaching up from the bottom of a phone. .modal__foot pushes a
    // --danger button to the far edge, which puts real space between "no" and
    // an irreversible "yes".
    shell.foot.append(cancel, confirm);

    shell.open();

    // Focus after open(), or the element is not in the document yet.
    (plan.focus === 'cancel' ? cancel : confirm).focus();
  });
}
/**
 * Opens a modal form and resolves once it closes — with the submitted values,
 * with null on cancel, or with 'deleted' when the delete button ran. What
 * onSubmit returns is discarded: a step that only collects a choice can omit
 * onSubmit entirely and read the choice off the resolved values.
 *
 * fields: [{ name, label, type, value, options, required, hint, placeholder }]
 *   type: text | email | textarea | date | number | select | checkbox |
 *         checkboxes | file
 *   options (select, checkboxes): [{ value, label }]
 *   value (checkboxes only): the option values ticked at open; the field
 *     resolves as an array of the values ticked at submit
 *   accept (file only): the picker's filter, e.g. 'application/pdf,.pdf'
 *   suggestions (text-like only): datalist entries — offered as you type,
 *     never enforced, so the field stays free text with a memory
 *
 * onSubmit(values) may be async; throwing keeps the modal open and shows the
 * message. onDelete, when given, renders a destructive button on the right.
 */
export function formModal({
  title,
  fields = [],
  // Collapsible sections, so a long form can look short without asking for
  // less. A field naming a group in `group` renders inside it instead of in
  // the body, and the <details> lands where its first member was declared.
  // { key, label, hint, open }.
  groups = [],
  submitLabel = 'Save',
  onSubmit,
  // Reactivity, for the forms where one answer decides another: a vendor that
  // knows its own category, a route that knows its own mileage, a section that
  // should be open because the category needs it. Called as
  // (name, values, api) on every change, and once with name === null as the
  // dialog opens so a form editing an existing row starts consistent.
  //
  // Before this, the one form that needed it — quick-add's board and column —
  // had to hand-build itself out of modalShell. A second hand-built copy of
  // this file's markup is a second copy to drift.
  onChange,
  onDelete,
  deleteLabel = 'Delete',
  // What the delete confirmation should say. { title, body } — body takes a
  // string or an array of paragraphs. A caller whose delete cascades should
  // always pass this: the default can only say "this cannot be undone", which
  // is true of every delete and informative about none of them.
  confirmDelete = {},
  intro,
}) {
  return new Promise((resolve) => {
    const inputs = new Map();
    // The control field.autofocus asked for, focused after open().
    let wanted = null;
    // What api.show() hides and the required check skips: the .form-field (or,
    // for a checkbox, its .check label) wrapping each control.
    const wrappers = new Map();
    // The hint line under each field, so api.hint() can rewrite it — "19 miles
    // last time" is worth saying where the number appears, not in a toast.
    const hints = new Map();
    const groupNodes = new Map();
    const shell = modalShell({ title, onClose: resolve });
    const { body, foot } = shell;

    // The intro sits above the error line, which modalShell put in first.
    if (intro) body.prepend(el('p', { class: 'progress__label', text: intro }));

    /** The <details> a grouped field goes in, built the first time one asks
     *  for it — which is what puts it where its first member was declared. */
    function groupNode(key) {
      if (groupNodes.has(key)) return groupNodes.get(key);

      const spec = groups.find((g) => g.key === key) || { key, label: key };
      // The summary's second line. It changes — "the IRS wants three more
      // things for a meal" is only true once a meal is the category — so it is
      // a node api.note() can rewrite rather than text baked into the label.
      const note = el('span', { class: 'form-group__note', text: spec.hint || '' });
      const fieldsBox = el('div', { class: 'form-group__fields' });
      const details = el('details', { class: 'form-group', open: Boolean(spec.open) }, [
        el('summary', {}, [el('span', { text: spec.label }), note]),
        fieldsBox,
      ]);

      const node = { details, fieldsBox, note };
      groupNodes.set(key, node);
      body.append(details);
      return node;
    }

    fields.forEach((field, index) => {
      const id = `mf-${field.name}`;
      let input;

      if (field.type === 'textarea') {
        input = el('textarea', { id, name: field.name, rows: field.rows || 4 });
        input.value = field.value == null ? '' : field.value;
      } else if (field.type === 'select') {
        // A disabled select still reports its value on submit; callers use it
        // for "you can see this but not change it" (your own role).
        input = el('select', { id, name: field.name, disabled: field.disabled });
        (field.options || []).forEach((option) => {
          input.append(el('option', {
            value: option.value,
            text: option.label,
            selected: String(option.value) === String(field.value),
          }));
        });
      } else if (field.type === 'checkbox') {
        input = el('input', { type: 'checkbox', id, name: field.name, checked: field.value });
      } else if (field.type === 'checkboxes') {
        // A group of boxes resolving as an array of the ticked values. Each
        // box lives inside its own label, so no ids are needed and the whole
        // row is the tap target — the same .check the single checkbox wears.
        const ticked = new Set((field.value || []).map(String));
        input = el('div', { class: 'check-group', role: 'group', 'aria-label': field.label },
          (field.options || []).map((option) => el('label', { class: 'check' }, [
            el('input', {
              type: 'checkbox',
              name: field.name,
              value: option.value,
              checked: ticked.has(String(option.value)),
            }),
            option.label,
          ])));
      } else if (field.type === 'file') {
        // Reaches onSubmit as a File or null rather than the fake path a file
        // input calls its value, so a caller can upload it without knowing that
        // .value is a lie.
        input = el('input', { type: 'file', id, name: field.name, accept: field.accept });
      } else {
        input = el('input', {
          type: field.type || 'text',
          id,
          name: field.name,
          placeholder: field.placeholder,
          required: field.required,
          // Without this a browser will cheerfully autofill the saved portal
          // password into every password box on a change-password form, so the
          // "current" and "new" fields arrive identical and the change fails
          // for a reason nobody can see. Callers pass new-password/off.
          autocomplete: field.autocomplete,
          // Phone keyboard hints. inputmode picks the keypad (a money field
          // wants digits without giving up free-form text), and the other
          // three stop iOS "fixing" values that must match byte-for-byte —
          // a generated password autocorrected is an account nobody can
          // open. el() skips whatever a caller leaves undefined.
          inputmode: field.inputmode,
          autocapitalize: field.autocapitalize,
          autocorrect: field.autocorrect,
          spellcheck: field.spellcheck,
          enterkeyhint: field.enterkeyhint,
          // Points at the datalist built below when suggestions are given;
          // el() skips the attribute entirely when they are not.
          list: field.suggestions && field.suggestions.length ? `${id}-list` : undefined,
        });
        input.value = field.value == null ? '' : field.value;
      }

      inputs.set(field.name, input);
      const target = field.group ? groupNode(field.group).fieldsBox : body;

      if (field.type === 'checkbox') {
        const wrapper = el('label', { class: 'check', for: id }, [input, field.label]);
        wrappers.set(field.name, wrapper);
        target.append(wrapper);
      } else {
        // field.action = { label, run(input) } puts a helper button beside the
        // input — Generate on a password box, and whatever comes next.
        //
        // field.clearable puts an ✕ inside the right edge instead, for a field
        // that arrives already filled in. A prefilled value is only a kindness
        // while correcting it is cheaper than typing it: the odometer carried
        // over from your last drive is right most days and wrong the day you
        // drove somewhere at the weekend, and the difference between those two
        // has to be one tap. Clearing focuses the box, so the ✕ and the
        // keyboard are the same gesture — and because a click IS a gesture,
        // iOS raises the keyboard for it.
        let control = input;

        if (field.action) {
          control = el('div', { class: 'form-field__with-action' }, [
            input,
            el('button', {
              class: 'btn btn--ghost btn--small',
              type: 'button',
              text: field.action.label,
              onclick: () => field.action.run(input),
            }),
          ]);
        } else if (field.clearable) {
          const clear = el('button', {
            class: 'form-field__clear',
            type: 'button',
            // Named for what it does to this field, because on a form of eight
            // boxes "Clear" alone is a promise a screen reader cannot place.
            'aria-label': `Clear ${field.label}`,
            hidden: !String(input.value || '').length,
            onclick: () => {
              input.value = '';
              clear.hidden = true;
              input.focus();
              // The watcher has to hear this: a cleared odometer is a changed
              // odometer, and assigning .value fires nothing on its own.
              input.dispatchEvent(new Event('input', { bubbles: true }));
            },
          }, [icon('x', { size: 16 })]);

          // Shown only when there is something to clear — an ✕ over an empty
          // box is a control that does nothing, sitting where the text goes.
          input.addEventListener('input', () => {
            clear.hidden = !String(input.value || '').length;
          });

          control = el('div', { class: 'form-field__clearable' }, [input, clear]);
        }

        // Always built, even where the caller passed no hint: api.hint() has
        // to have something to write into, and an empty span shows nothing.
        const hint = el('span', { class: 'progress__label', text: field.hint || '' });
        hints.set(field.name, hint);

        const wrapper = el('div', { class: 'form-field' }, [
          // A checkbox group carries a label per box, so its heading is a
          // span — a <label for> pointing at a <div> would name nothing.
          el(field.type === 'checkboxes' ? 'span' : 'label',
            field.type === 'checkboxes' ? { class: 'form-field__label' } : { for: id }, [
              field.label,
              !field.required && field.type !== 'select' && field.type !== 'checkboxes'
                ? el('span', { class: 'label-optional', text: ' (optional)' })
                : null,
            ]),
          control,
          field.suggestions && field.suggestions.length
            ? el('datalist', { id: `${id}-list` },
              field.suggestions.map((value) => el('option', { value })))
            : null,
          hint,
        ]);

        wrappers.set(field.name, wrapper);
        target.append(wrapper);

        // Every textarea in a form dialog gets the staff-only AI rewrite
        // button, unless the field opts out with `aiRewrite: false`. Lazy, so
        // a dialog without a textarea never loads the module; defensive
        // inside, so a failure degrades to no button, never a broken form.
        if (field.type === 'textarea' && field.aiRewrite !== false) {
          import('./ai-rewrite.js')
            .then((mod) => mod.attachAiRewrite(input, { surface: `form:${field.name}` }))
            .catch(() => {});
        }
      }

      // Reactivity is wired per input rather than delegated, because a
      // checkbox group's boxes are not the element the map holds. `input` as
      // well as `change` so a datalist pick and a select both land at once;
      // api.set() assigns .value directly, which fires nothing, so nothing
      // here can feed itself.
      if (onChange) {
        const fire = () => {
          try {
            onChange(field.name, readValues(), api);
          } catch {
            // A convenience must never be what stops a form being filled in.
          }
        };
        input.addEventListener('change', fire);
        if (input.tagName === 'INPUT' && input.type !== 'checkbox' && input.type !== 'file') {
          input.addEventListener('input', fire);
        }
      }

      // Autofocus is a courtesy on a desktop and a bill on a phone: the soft
      // keyboard (or, for a date or select, the native wheel) springs up over
      // a dialog the person has not read yet.
      //
      // field.autofocus opts out of that caution, for the dialog where the
      // caution is wrong: one box, whose entire content is a number, opened by
      // someone who tapped a button meaning "let me type a number". There is
      // nothing to read first, and making them tap the field is a tap that
      // exists for no reason. Handled after open() rather than here — see
      // below.
      if (field.autofocus) wanted = input;

      if (index === 0 && !field.autofocus
          && !window.matchMedia('(pointer: coarse)').matches) {
        window.setTimeout(() => input.focus(), 50);
      }
    });

    /**
     * What onChange is handed to answer with.
     *
     * Every method is a no-op on a name the form does not carry, so a caller
     * can drive a field it only sometimes builds without guarding each call.
     */
    const api = {
      /** Fill a field in. A checkbox takes a boolean; everything else a string. */
      set(name, value) {
        const input = inputs.get(name);
        if (!input) return;
        if (input.type === 'checkbox') input.checked = Boolean(value);
        else input.value = value == null ? '' : value;
      },
      /** Repopulate a select — the thing this whole hook exists for. */
      setOptions(name, options, value) {
        const input = inputs.get(name);
        if (!input || input.tagName !== 'SELECT') return;
        const keep = value === undefined ? input.value : value;
        mount(input, ...(options || []).map((option) => el('option', {
          value: option.value,
          text: option.label,
        })));
        input.value = keep == null ? '' : keep;
      },
      /** Take a field off the screen. Hidden fields are skipped by the
       *  required check — a form cannot demand what it will not show. */
      show(name, visible = true) {
        const wrapper = wrappers.get(name);
        if (wrapper) wrapper.hidden = !visible;
      },
      /** Rewrite the line under a field: where a prefilled number came from. */
      hint(name, text) {
        const node = hints.get(name);
        if (node) node.textContent = text || '';
      },
      /** Open (or close) a collapsible section. */
      openGroup(key, open = true) {
        const node = groupNodes.get(key);
        if (node) node.details.open = open;
      },
      /** Rewrite a section's summary line, so a closed section can still say
       *  what is waiting inside it. */
      note(key, text) {
        const node = groupNodes.get(key);
        if (node) node.note.textContent = text || '';
      },
    };

    // Once before anything is touched, so a form opened on an existing row
    // starts in the state a change would have put it in.
    if (onChange) {
      try {
        onChange(null, readValues(), api);
      } catch {
        // As above: never the thing that stops the dialog opening.
      }
    }

    const submitBtn = el('button', { class: 'btn', type: 'submit', text: submitLabel });
    const cancelBtn = el('button', { class: 'btn btn--ghost', type: 'button', text: 'Cancel' });

    foot.append(submitBtn, cancelBtn);

    if (onDelete) {
      // Submit disables itself for the round trip and this did not, which on
      // a destructive action against a live database is the worse half to
      // miss: a second click while the first delete is in flight sends the
      // delete twice, and the second one 404s or — worse, where the delete is
      // by position rather than by id — takes something else with it.
      const deleteBtn = el('button', {
        class: 'btn btn--danger',
        type: 'button',
        text: deleteLabel,
        onclick: async () => {
          if (deleteBtn.disabled) return;
          // One dialog, not two. This used to ask a generic "Delete X? This
          // cannot be undone." and then hand off to an onDelete that asked
          // again, with the wording that actually named the cascade — so a
          // client deletion put two OS alerts on the screen back to back, and
          // declining the second one came back as a red error notice reading
          // "Nothing was deleted." confirmDelete lets the caller put its own
          // words in the one dialog there should always have been.
          const ok = await confirmModal({
            title: confirmDelete.title || `${deleteLabel}?`,
            body: confirmDelete.body || 'This cannot be undone.',
            confirmLabel: deleteLabel,
            tone: 'danger',
          });
          if (!ok) return;
          deleteBtn.disabled = true;
          deleteBtn.textContent = 'Deleting…';
          submitBtn.disabled = true;
          try {
            await onDelete();
            close('deleted');
          } catch (error) {
            deleteBtn.disabled = false;
            deleteBtn.textContent = deleteLabel;
            showError(error);
          }
        },
      });
      foot.append(deleteBtn);
    }

    const form = el('form', { novalidate: true }, [body, foot]);
    shell.dialog.append(form);

    const close = shell.close;

    function showError(error) {
      shell.showError(error);
      submitBtn.disabled = false;
      submitBtn.textContent = submitLabel;
    }

    function readValues() {
      const values = {};
      for (const [name, input] of inputs) {
        if (input.classList && input.classList.contains('check-group')) {
          values[name] = [...input.querySelectorAll('input:checked')]
            .map((box) => box.value);
        } else if (input.type === 'checkbox') {
          values[name] = input.checked;
        } else if (input.type === 'file') {
          values[name] = (input.files && input.files[0]) || null;
        } else {
          values[name] = input.value.trim();
        }
      }
      return values;
    }

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const values = readValues();

      const missing = fields.find((field) => {
        if (!field.required || field.type === 'checkbox') return false;
        // api.show(name, false) took it off the screen, so it is not being
        // asked for. Demanding a field nobody can see is an error with no
        // fix in it.
        const wrapper = wrappers.get(field.name);
        if (wrapper && wrapper.hidden) return false;
        const value = values[field.name];
        return Array.isArray(value) ? !value.length : !value;
      });
      if (missing) {
        showError(new Error(`${missing.label} is required.`));
        // A required field inside a closed section cannot be focused into
        // view, so the section opens first — otherwise the error names a box
        // that is nowhere on the screen.
        if (missing.group) {
          const node = groupNodes.get(missing.group);
          if (node) node.details.open = true;
        }
        const target = inputs.get(missing.name);
        // A group cannot take focus itself; its first box can.
        (target.classList.contains('check-group')
          ? target.querySelector('input') || target
          : target).focus();
        return;
      }

      shell.clearError();
      submitBtn.disabled = true;
      submitBtn.textContent = 'Saving…';

      try {
        if (onSubmit) await onSubmit(values);
        close(values);
      } catch (error) {
        showError(error);
      }
    });

    cancelBtn.addEventListener('click', () => close(null));
    shell.open();

    // After open(), because focusing a control that is not in the document yet
    // does nothing, and because open() focuses the dialog container — running
    // last is what makes this win.
    //
    // Synchronous, and that is the whole trick on a phone. iOS Safari raises
    // the soft keyboard only for a focus() that happens inside the user
    // gesture that led to it, and a setTimeout — even a zero one — is a new
    // task, which is a gesture the browser no longer believes in. Every caller
    // reaches here in the same task as the tap that opened the dialog, so this
    // one line is the difference between a cursor in the box and a keyboard
    // under it.
    //
    // Worth knowing what this cannot do: a dialog opened from a page load
    // rather than a tap (arriving on ?drive=1) has no gesture to inherit, so
    // iOS focuses the field and shows no keyboard. There is no way around
    // that, and nothing here pretends otherwise.
    if (wanted) wanted.focus();
  });
}

/** The one status chip, keyed by every status this portal has: an invoice's,
 *  a client's, and the two tags an expense carries. An unknown value still
 *  renders — title-cased, in the neutral tone — because a pill that vanishes
 *  hides the fact that something has a status at all. */
export function statusPill(status) {
  const tone = {
    // Invoices
    draft: '',
    issued: 'blue',
    sent: 'blue',
    paid: 'green',
    void: 'red',
    overdue: 'red',
    // Clients
    active: 'green',
    lead: 'amber',
    past: '',
    // Expenses
    billable: 'amber',
    billed: 'green',
  }[status] || '';

  return el('span', {
    class: tone ? `pill pill--${tone}` : 'pill',
    text: titleCase(status),
  });
}

// Figures
// ---------------------------------------------------------------------------

/** One big number with a small label over it, and an optional line under it.
 *  The ledger's front page and the Dashboard share these, which is why they
 *  live here and not in either. tone 'bad' turns the value red. */
export function figure(label, value, note, tone) {
  return el('div', { class: 'figure' }, [
    el('p', { class: 'figure__label', text: label }),
    el('p', { class: tone ? `figure__value figure__value--${tone}` : 'figure__value', text: value }),
    note ? el('p', { class: 'figure__note', text: note }) : null,
  ]);
}

/** The row the figures sit in — a grid that wraps on a phone. */
export function figureRow(figures) {
  return el('div', { class: 'figure-row' }, figures);
}

// Panels and tables
// ---------------------------------------------------------------------------
//
// The list screens — Clients, Invoices, Expenses, Admin — are all the same
// shape: a titled panel with one action in its corner and a table under it. These live here rather than in any one of them so splitting
// a screen out into its own page never means copying the phone layout with it.

/** A panel's title bar: heading on the left, one action on the right, and an
 *  optional line of explanation under the heading. */
export function panelHead(title, action, lede) {
  return el('div', { class: 'panel__head' }, [
    el('div', {}, [
      el('h2', { text: title }),
      lede ? el('p', { class: 'progress__label', text: lede }) : null,
    ]),
    action ? el('div', { class: 'page-head__actions' }, [action]) : null,
  ]);
}

/**
 * A table that is still readable on a phone.
 *
 * Each cell is stamped with its column name. Below 640px the table restyles
 * into stacked cards and the header row is hidden, so the label has to travel
 * with the cell — doing it here means every caller gets it without its row
 * builders knowing anything about it. See the `.table` rules in portal.css.
 *
 * `wide` is for the ledger's tables, which carry more columns than the rest of
 * the portal's and would otherwise be squeezed rather than allowed to scroll.
 * `className` lets a caller opt into a variant (the People table's tighter
 * type) without this helper knowing every table on the site.
 */
export function table(headings, rows, { wide = false, className = '' } = {}) {
  rows.forEach((row) => {
    Array.from(row.children).forEach((cell, index) => {
      if (headings[index]) cell.dataset.label = headings[index];
    });
  });

  return el('div', { class: 'table-scroll' }, [
    el('table', {
      class: ['table', wide ? 'table--wide' : '', className].filter(Boolean).join(' '),
    }, [
      el('thead', {}, [
        el('tr', {}, headings.map((heading) => el('th', { scope: 'col', text: heading }))),
      ]),
      el('tbody', {}, rows),
    ]),
  ]);
}

/** Stacked lines in one cell: the first plain, the rest muted. An email above a
 *  phone number is one column, not two half-empty ones. */
export function stackedCell(values) {
  const lines = values.filter(Boolean);
  if (!lines.length) return ['—'];
  return lines.map((line, index) => el('div', {
    class: index === 0 ? null : 'progress__label',
    text: line,
  }));
}

/** A labelled control in a filter bar. Labels are visible rather than
 *  placeholder-only: two unlabelled date boxes are a puzzle. */
export function filterField(id, label, input) {
  return el('div', { class: 'form-field' }, [
    el('label', { for: id, text: label }),
    input,
  ]);
}
