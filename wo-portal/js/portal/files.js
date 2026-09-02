// ---------------------------------------------------------------------------
// Helpers shared by everything that puts a file in a Supabase bucket — the
// Documents tab and the master agreement on the client record page. One
// definition each, so a filename judged safe for one bucket is safe for all.
// ---------------------------------------------------------------------------

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/** Storage keys must stay printable ASCII — the object path is also a URL. */
export function safeName(name) {
  const base = String(name || '').split(/[\\/]/).pop();
  return base
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/, '') || 'file';
}

/**
 * Ask for one file, without putting a file input on the page.
 *
 * The upload forms elsewhere in the portal are deliberate, multi-field affairs
 * — pick a file, say which project it belongs to, say what kind it is. A
 * receipt is the opposite: it hangs off a row that already knows everything,
 * and the whole interaction should be one tap. `capture` is left off on
 * purpose, so a phone offers the camera *and* the photo library rather than
 * forcing the camera on somebody filing last month's receipts.
 *
 * Resolves with the File, or null if the picker was dismissed. The input never
 * enters the document: it is clicked where it stands, which every browser
 * allows inside a user gesture.
 */
export function pickFile({ accept = '', multiple = false, capture = '' } = {}) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    if (accept) input.accept = accept;
    if (multiple) input.multiple = true;
    // `capture` opens the camera straight away instead of the file browser.
    // Set only where the caller means it — the receipt gallery offers both, so
    // that filing a shoebox of paper later is as easy as snapping one now.
    if (capture) input.capture = capture;

    input.addEventListener('change', () => {
      const chosen = Array.from(input.files || []);
      resolve(multiple ? chosen : (chosen[0] || null));
    }, { once: true });

    // Cancelling a file dialog fires nothing at all in older browsers, so the
    // promise would hang forever and the caller's button stay disabled. `cancel`
    // is the modern signal; where it does not exist the promise simply settles
    // on the next pick instead, which is the same behaviour as before.
    input.addEventListener('cancel', () => resolve(multiple ? [] : null), { once: true });

    input.click();
  });
}

/**
 * Shrink a photograph before it is uploaded.
 *
 * A phone camera produces 4–8 MB per shot and a receipt needs a fraction of
 * that: 2000px on the long edge keeps the small print legible while landing
 * around 300 KB. That matters twice over — the studio is filing these from a
 * restaurant on a phone connection, and a year of receipts should be tens of
 * megabytes rather than gigabytes.
 *
 * Three things it deliberately does not do:
 *
 *   It never grows a file. If the re-encode comes out larger — already-small
 *   images, screenshots of PDFs — the original is returned untouched.
 *   It never touches a PDF. Those are already small and re-encoding one as JPEG
 *   would turn text into a picture of text.
 *   It never fails the upload. A format the browser cannot decode (HEIC outside
 *   Safari is the common one) falls back to the original, which the bucket
 *   accepts anyway.
 *
 * Resolves { file, width, height } — the caller wants the dimensions for the
 * thumbnail decision.
 */
export async function shrinkImage(file, { maxEdge = 2000, quality = 0.82 } = {}) {
  if (!file || !/^image\//.test(file.type) || file.type === 'image/svg+xml') {
    return { file, width: 0, height: 0 };
  }

  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return { file, width: 0, height: 0 };
  }

  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const blob = await new Promise((resolve) => {
    canvas.toBlob(resolve, 'image/jpeg', quality);
  });

  if (!blob || blob.size >= file.size) return { file, width, height };

  // Renamed to .jpg, because a file called receipt.heic holding JPEG bytes is
  // one that opens in nothing a year from now.
  const name = file.name.replace(/\.[^.]+$/, '') || 'receipt';
  return {
    file: new File([blob], `${name}.jpg`, { type: 'image/jpeg' }),
    width,
    height,
  };
}

/**
 * A small square-ish version for the gallery.
 *
 * Returns null rather than throwing for anything that is not a decodable image:
 * a PDF receipt simply has no thumbnail and the gallery shows an icon instead.
 */
export async function makeThumbnail(file, { edge = 400, quality = 0.7 } = {}) {
  if (!file || !/^image\//.test(file.type) || file.type === 'image/svg+xml') return null;

  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return null;
  }

  const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  const blob = await new Promise((resolve) => {
    canvas.toBlob(resolve, 'image/jpeg', quality);
  });

  if (!blob) return null;
  const name = file.name.replace(/\.[^.]+$/, '') || 'receipt';
  return new File([blob], `${name}-thumb.jpg`, { type: 'image/jpeg' });
}

/** A row can outlive its object — recognise storage saying so, in the several
 *  ways it phrases it, so the UI can say "gone" rather than "error". */
export function isMissingObject(error) {
  const raw = (error && (error.message || error.error)) || '';
  return /not.?found|does not exist|no such/i.test(String(raw));
}
