// ---------------------------------------------------------------------------
// Documents panel on the client record page.
//
// The filing cabinet for one client: the W-9, the signed engagement letter,
// the brand files, the PDFs that need finding in a year. One table
// (`documents`), one private bucket (`client-documents`), staff-only in both
// directions. Bytes live at <client_id>/<uuid>-<safeName> in the bucket; the
// row is the index of them.
//
// Signed URLs are minted on click, never rendered into the page, so a stale
// tab left open on a shared screen carries no working links. `download` on
// the signed URL makes storage answer with Content-Disposition: attachment,
// which both keeps the original filename and stops an uploaded .html from ever
// executing on the storage origin.
//
// No kinds, no approval flow, no attachment picker: a free-text label is the
// whole taxonomy, because "W-9 2026" says more than "Other" ever did.
// ---------------------------------------------------------------------------

import { supabase, errorMessage } from './client.js';
import { DOCUMENTS_BUCKET } from './config.js';
import {
  el, mount, toast, busy, fmtBytes, fmtDate, confirmModal, formModal,
} from './ui.js';
import { safeName, pickFile, isMissingObject, MAX_UPLOAD_BYTES } from './files.js';

// What the bucket accepts, by extension. This is the bucket's own allow-list
// (supabase/schema.sql, client-documents) restated so the browser can say no
// before the round trip — and so the upload's contentType is always one of
// these. Storage refuses application/octet-stream outright, and a phone
// picker leaves `file.type` blank often enough that the extension has to be
// the fallback.
const CONTENT_TYPES = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  heic: 'image/heic',
  heif: 'image/heif',
  webp: 'image/webp',
  txt: 'text/plain',
  csv: 'text/csv',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

const ALLOWED_TYPES = new Set(Object.values(CONTENT_TYPES));

/** The picker's filter: every allowed MIME type and every extension, because
 *  iOS filters on the former and desktop browsers are happier with the latter. */
export const DOCUMENT_ACCEPT = [
  ...new Set(Object.values(CONTENT_TYPES)),
  ...Object.keys(CONTENT_TYPES).map((ext) => `.${ext}`),
].join(',');

/**
 * The content type to upload a file as, or null when the bucket would refuse
 * it. The declared type wins when it is one we accept; otherwise the
 * extension decides.
 */
export function documentContentType(file) {
  const declared = String((file && file.type) || '').toLowerCase();
  if (ALLOWED_TYPES.has(declared)) return declared;
  const ext = String((file && file.name) || '').split('.').pop().toLowerCase();
  return CONTENT_TYPES[ext] || null;
}

const DOC_SELECT = '*, uploaded_by_profile:profiles!documents_uploaded_by_fkey(full_name, email)';

/** The byline. Staff can read every profile, so the embed normally resolves;
 *  it comes back null for an uploader whose sign-in has since been removed. */
function uploaderName(doc, ctx) {
  const profile = doc.uploaded_by_profile;
  if (profile && profile.full_name) return profile.full_name;
  if (profile && profile.email) return profile.email.split('@')[0];
  if (doc.uploaded_by && ctx && ctx.profile && doc.uploaded_by === ctx.profile.id) return 'You';
  return '';
}

/**
 * Draw the panel into `host` and keep it current. Resolves once the first
 * load has finished; a failure in here costs this panel, not the record
 * around it.
 */
export async function renderClientDocuments(host, ctx, client) {
  const listWrap = el('div', {}, [el('p', { class: 'skeleton', text: 'Loading documents…' })]);

  mount(host, buildUpload(), listWrap);
  await load();

  async function load() {
    let docs;
    try {
      const { data, error } = await supabase
        .from('documents')
        .select(DOC_SELECT)
        .eq('client_id', client.id)
        .order('created_at', { ascending: false });
      if (error) throw error;
      docs = data || [];
    } catch (error) {
      // load() is in scope, so a retry beats asking for the whole page again.
      toast(errorMessage(error), 'error');
      mount(listWrap, el('div', {}, [
        el('p', { class: 'notice notice--error', text: errorMessage(error, 'Could not load these documents.') }),
        el('button', {
          class: 'btn btn--ghost btn--small',
          type: 'button',
          text: 'Try again',
          onclick: () => load(),
        }),
      ]));
      return;
    }

    if (!docs.length) {
      mount(listWrap, el('p', {
        class: 'empty',
        text: 'Nothing filed yet. The W-9, the signed engagement letter, the '
            + 'files you will need to find in a year — this is where they live.',
      }));
      return;
    }

    mount(listWrap, el('div', { class: 'doc-list' }, docs.map((doc) => docRow(doc, ctx, load))));
  }

  // Upload
  // -------------------------------------------------------------------------

  /**
   * One button, then one question. The picker opens straight from the tap —
   * a file input on the page would be a second control to explain — and the
   * label is asked for afterwards, with the filename in the title so the
   * question is about a file the person has just chosen rather than one they
   * are about to.
   */
  function buildUpload() {
    const button = el('button', {
      class: 'btn btn--small',
      type: 'button',
      text: 'Add a document',
      onclick: busy(async () => {
        const file = await pickFile({ accept: DOCUMENT_ACCEPT });
        if (!file) return;

        if (file.size > MAX_UPLOAD_BYTES) {
          toast(
            `${file.name} is ${fmtBytes(file.size)} — the limit is ${fmtBytes(MAX_UPLOAD_BYTES)}.`,
            'error',
          );
          return;
        }

        const contentType = documentContentType(file);
        if (!contentType) {
          toast(
            `${file.name} is not a kind of file that can be filed here. PDFs, `
            + 'photos, text, CSV, Word and Excel files are.',
            'error',
          );
          return;
        }

        const result = await formModal({
          title: `File ${file.name}`,
          submitLabel: 'Upload',
          intro: `${fmtBytes(file.size)}, filed under ${client.name}.`,
          fields: [{
            name: 'label',
            label: 'Label',
            type: 'text',
            placeholder: 'W-9 2026',
            hint: 'What it is, in your words. Shown beside the filename in the list.',
          }],
          onSubmit: (values) => upload(file, contentType, values.label),
        });

        if (result) {
          toast('Uploaded', 'ok');
          await load();
        }
      }, { label: 'Choosing…' }),
    });

    return el('div', { class: 'upload' }, [
      el('div', { class: 'btn-row' }, [button]),
      el('span', {
        class: 'progress__label upload__note',
        text: `One file at a time, up to ${fmtBytes(MAX_UPLOAD_BYTES)}: PDFs, photos, `
            + 'text, CSV, Word and Excel. Only staff can see what is filed here.',
      }),
    ]);
  }

  /**
   * Object first, row second. An object with no row is invisible in the UI
   * but still bills for storage forever, so a failed insert removes what was
   * just uploaded before surfacing the failure. Throws with a human sentence,
   * which formModal shows without closing.
   */
  async function upload(file, contentType, label) {
    // The first path segment is the client id, which is how the folder can be
    // swept when the client is deleted. randomUUID needs a secure context,
    // which https and localhost both are.
    const path = `${client.id}/${crypto.randomUUID()}-${safeName(file.name)}`;

    const uploaded = await supabase.storage
      .from(DOCUMENTS_BUCKET)
      .upload(path, file, { contentType });
    if (uploaded.error) throw new Error(errorMessage(uploaded.error));

    const { error } = await supabase.from('documents').insert({
      client_id: client.id,
      name: file.name,
      storage_path: path,
      label: String(label || '').trim() || null,
      size_bytes: file.size,
      mime_type: contentType,
      uploaded_by: ctx.profile.id,
    });

    if (error) {
      try {
        await supabase.storage.from(DOCUMENTS_BUCKET).remove([path]);
      } catch (cleanupError) {
        // Nothing useful to tell the person here; the insert error is the story.
      }
      throw new Error(errorMessage(error));
    }
  }
}

// Rows
// ---------------------------------------------------------------------------

/** One document: what it is, how big, when, by whom — and download or delete. */
function docRow(doc, ctx, reload) {
  const who = uploaderName(doc, ctx);

  const meta = el('p', { class: 'doc-row__meta' }, [
    doc.label ? el('span', { class: 'pill pill--blue pill--wrap', text: doc.label }) : null,
    doc.size_bytes ? el('span', { text: fmtBytes(doc.size_bytes) }) : null,
    el('span', { text: `Added ${fmtDate(doc.created_at)}` }),
    who ? el('span', { text: who }) : null,
  ]);

  return el('div', { class: 'doc-row' }, [
    el('div', {}, [
      el('p', { class: 'doc-row__name', text: doc.name }),
      meta,
    ]),
    el('div', { class: 'btn-row' }, [
      downloadButton(doc),
      deleteButton(doc, reload),
    ]),
  ]);
}

function downloadButton(doc) {
  return el('button', {
    class: 'btn btn--ghost btn--small',
    type: 'button',
    text: 'Download',
    'aria-label': `Download ${doc.name}`,
    onclick: busy(async () => {
      try {
        // Sixty seconds is long enough to click and short enough that a link
        // copied out of the network tab is worthless by lunchtime.
        const { data, error } = await supabase.storage
          .from(DOCUMENTS_BUCKET)
          .createSignedUrl(doc.storage_path, 60, { download: doc.name });
        if (error) throw error;

        const link = el('a', { href: data.signedUrl, download: doc.name, rel: 'noopener' });
        document.body.append(link);
        link.click();
        link.remove();
      } catch (error) {
        toast(
          isMissingObject(error)
            ? `${doc.name} is no longer in storage. Delete the row and file it again.`
            : errorMessage(error),
          'error',
        );
      }
    }, { label: 'Opening…' }),
  });
}

function deleteButton(doc, reload) {
  return el('button', {
    class: 'btn btn--danger btn--small',
    type: 'button',
    text: 'Delete',
    'aria-label': `Delete ${doc.name}`,
    onclick: busy(async () => {
      const ok = await confirmModal({
        title: `Delete ${doc.name}?`,
        body: 'The file is removed from storage as well. This cannot be undone.',
        confirmLabel: 'Delete document',
        tone: 'danger',
      });
      if (!ok) return;

      try {
        // Object first — the row holds the only copy of the path. A missing
        // object must not strand the row that points at it.
        const removal = await supabase.storage.from(DOCUMENTS_BUCKET).remove([doc.storage_path]);
        if (removal.error && !isMissingObject(removal.error)) throw removal.error;

        const { error } = await supabase.from('documents').delete().eq('id', doc.id);
        if (error) throw error;

        toast('Deleted', 'ok');
        await reload();
      } catch (error) {
        toast(errorMessage(error), 'error');
      }
    }, { label: 'Deleting…' }),
  });
}
