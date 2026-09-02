// ---------------------------------------------------------------------------
// The print dialog dance, shared by every document the portal prints.
//
// Grew out of sow-print.js when the master agreement became a second printable
// contract: the container work is different per document, but the dialog dance
// around it — the filename, the running footer, the cleanup — is exactly the
// same steps in exactly the same order, and it is subtle enough that two copies
// would drift.
// ---------------------------------------------------------------------------

/**
 * A display:none <img> is still fetched, but printing before it lands leaves a
 * hole where the mark should be. Never blocks for long — the dialog is worth
 * more than the logo.
 */
function imageReady(img, timeout = 2000) {
  if (!img || (img.complete && img.naturalWidth)) return Promise.resolve();

  return new Promise((resolve) => {
    let timer = 0;
    const done = () => {
      window.clearTimeout(timer);
      resolve();
    };
    timer = window.setTimeout(done, timeout);
    img.addEventListener('load', done, { once: true });
    img.addEventListener('error', done, { once: true });
  });
}

/**
 * Append a purpose-built print container, open the dialog, and put everything
 * back afterwards.
 *
 * `filename` is set as the document title for the duration of the dialog,
 * because that is what every browser offers as the default name in Save as PDF.
 * It is put back afterwards — a tab left titled like a download is a small
 * thing, but it is the sort of small thing that makes software feel broken.
 *
 * `footer` is the running footer's text, handed to the @page margin box that
 * draws it (css/print.css). A margin box can only read a custom property, and
 * @page inherits from the root element — hence documentElement rather than the
 * container.
 *
 * The value has to be a CSS <string>, so it is quoted and escaped rather than
 * interpolated: a party name with a quote or a backslash in it would otherwise
 * produce a declaration the parser drops, and the footer would silently vanish.
 * Setting it through .style is CSSOM, not an inline style attribute, so the
 * site's style-src without 'unsafe-inline' is untroubled.
 */
export async function openPrintDialog({ container, filename, footer }) {
  if (container.id) {
    const stale = document.getElementById(container.id);
    if (stale) stale.remove();
  }

  document.body.append(container);

  await imageReady(container.querySelector('img'));

  const previousTitle = document.title;
  if (filename) document.title = filename.replace(/\.pdf$/i, '');

  const cssString = JSON.stringify(String(footer || ''));
  document.documentElement.style.setProperty('--sow-party', cssString);

  const cleanup = () => {
    container.remove();
    document.documentElement.style.removeProperty('--sow-party');
    document.title = previousTitle;
  };

  window.addEventListener('afterprint', cleanup, { once: true });

  try {
    window.print();
  } catch (error) {
    window.removeEventListener('afterprint', cleanup);
    cleanup();
    throw new Error('This browser would not open its print dialog.');
  }
}
