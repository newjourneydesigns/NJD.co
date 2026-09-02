// ---------------------------------------------------------------------------
// Documents section
//
// Two jobs, and the second one is the reason this exists: hand files down to
// the client, and give them a place to hand files back up. Chasing logos and
// copy over email is the thing this replaces.
//
// The row rendering here is shared with the client record page
// (client-documents.js), where a document can be attached to the client
// itself rather than to a project. Which of the two it is decides the bucket
// it lives in — docBucket() below is that rule — and who can read it: project
// documents are the client's to see, client documents are staff-only.
//
// Signed URLs are minted on click, never rendered into the page, so a stale
// tab left open on a shared screen carries no working links.
//
// Signed contracts are review-only
// --------------------------------
// A document that a `signature_requests` row points at is the executed copy of
// something a client typed their name onto. It renders here with one
// affordance: download. No delete, no approve, no rename, for staff or for the
// client — PRD §5.6. It is evidence, and deleting evidence must not be a
// two-click accident on a Tuesday.
//
// Which rows those are arrives with the query rather than being asked about per
// row. DOC_SELECT embeds the reverse of `signature_requests.document_id`, so
// every list that already loads documents learns the answer for free, in the
// round trip it was already making, and a list this file has never heard of
// gets it too. The alternatives were both worse: a set of ids assembled by each
// caller (the project tab has no client id to assemble one from) or a lookup
// per row, which is the N+1 this note exists to rule out. RLS still applies to
// the embed — `signature_requests_select` shows a client their own — and a row
// with no request comes back with an empty array, which is the common case and
// costs an index probe on `signature_requests_document_idx`.
// ---------------------------------------------------------------------------

import { supabase, errorMessage } from './client.js';
import { signalWork } from './timer-nudge.js';
import { CLIENT_DOCUMENTS_BUCKET, DOCUMENTS_BUCKET } from './config.js';
import {
  el, mount, toast, fmtBytes, fmtDate, titleCase, confirmModal, panelHead,
} from './ui.js';
import { safeName, isMissingObject, MAX_UPLOAD_BYTES } from './files.js';
import { driveLinkBar } from './drive-link.js';

export const DOC_KINDS = ['proposal', 'contract', 'invoice', 'asset', 'deliverable', 'other'];

// documents has two foreign keys into profiles (uploaded_by and approved_by),
// so an unhinted `profiles(...)` embed is ambiguous and PostgREST refuses it.
// Only the uploader is displayed; approved_by is deliberately not embedded.
//
// The signature_requests embed is hinted for the same reason even though there
// is only one foreign key between the two tables today: a second one would turn
// an unhinted embed into a 400 at runtime, and naming the constraint means that
// day is a schema change rather than a broken Documents section.
//
// Composed from parts because there are two selects and they differ by one
// word. PostgREST will not accept the same relationship embedded twice in one
// select — it fails with a Postgres aggregate error rather than anything that
// names the real problem — so the inner variant has to be built instead of
// appended to the outer one.
const DOC_BASE = '*, uploaded_by_profile:profiles!documents_uploaded_by_fkey(full_name, email)';
const SIGNED_EMBED = 'signature_requests!signature_requests_document_id_fkey';
const SIGNED_COLUMNS = '(id, doc_type, status, title, sent_at)';

export const DOC_SELECT = `${DOC_BASE}, ${SIGNED_EMBED}${SIGNED_COLUMNS}`;

/**
 * The same row, narrowed to documents that a signature request points at.
 *
 * `!inner` turns the embed into a filter: only documents with a matching
 * request come back, and a filter on `signature_requests.status` then narrows
 * it to the signed ones. What the caller does *not* have to supply is a client
 * id — RLS decides whose contracts these are, which is the only correct answer
 * for a person linked to more than one company. js/portal/client-contracts.js
 * is the caller.
 */
export const CONTRACT_SELECT = `${DOC_BASE}, ${SIGNED_EMBED}!inner${SIGNED_COLUMNS}`;

/** A document attached to the client record lives in the staff-only bucket;
 *  one attached to a project lives where the project tab can hand it to the
 *  client. The row's storage_path only means something in the right bucket. */
export function docBucket(doc) {
  return doc.client_id ? CLIENT_DOCUMENTS_BUCKET : DOCUMENTS_BUCKET;
}

let uid = 0;

function nextId(prefix) {
  uid += 1;
  return `${prefix}-${uid}`;
}

function isAwaiting(doc) {
  return Boolean(doc.needs_approval && !doc.approved_at);
}

/**
 * Is this the executed copy of something somebody signed?
 *
 * True when any signature request points at it, whatever state that request is
 * in. Deliberately not narrowed to `status = 'signed'`: a request only ever
 * gets a document_id at the moment finalize_signature() files the PDF, so
 * anything pointed at has been signed — and if a later state ever changed that,
 * failing towards "protect the file" is the right direction to fail in.
 *
 * A caller whose query did not ask for the embed gets `undefined` and therefore
 * `false`, which is the old behaviour and the right failure: this is an
 * affordance, never a boundary. What actually protects a signed contract is the
 * database — `documents_admin_write`, and the freeze trigger that will not let
 * a signed request go. A missing button is a courtesy on top of that.
 */
export function isSignedContract(doc) {
  const requests = doc && doc.signature_requests;
  if (Array.isArray(requests)) return requests.length > 0;
  return Boolean(requests);
}

/**
 * profiles is readable only for yourself unless you are an admin, so a client
 * viewing an admin's upload gets a null embed. Everyone else who can write to
 * a project is us, so name us rather than showing a blank byline.
 */
function uploaderName(doc, ctx) {
  const profile = doc.uploaded_by_profile;
  if (profile && profile.full_name) return profile.full_name;
  if (profile && profile.email) return profile.email.split('@')[0];
  if (doc.uploaded_by && doc.uploaded_by === ctx.profile.id) return 'You';
  return doc.uploaded_by ? 'New Journey Designs' : '';
}

export async function renderDocuments(panel, ctx, project) {
  const notice = el('p', { class: 'notice notice--warn', hidden: true });
  const listWrap = el('div', {}, [el('p', { class: 'skeleton', text: 'Loading documents…' })]);
  const clientDocsHost = el('div');

  // The shared Drive folder, first — the working files live there before
  // anything is finished enough to be filed below. The client sees the button
  // whenever a link is set (drive_url rides the project row their RLS already
  // shows them); only staff see the Add/Edit side, and only RLS enforces that.
  const drive = driveLinkBar({
    url: project.drive_url,
    canEdit: ctx.isAdmin,
    subject: project.name,
    intro: `The shared folder for ${project.name}. The button appears here on `
         + 'the Documents section for everyone who can open this project — the '
         + 'client included, so share the folder with them in Drive first or '
         + 'the button will only show them a request-access page.',
    save: async (url) => {
      const { error } = await supabase
        .from('projects').update({ drive_url: url }).eq('id', project.id);
      if (error) throw new Error(errorMessage(error));
      project.drive_url = url;
    },
    barClass: 'drive-bar',
  });

  // The project's own files in one panel, the client record's in its own below
  // it — the second already brings its own .panel, so it stays a sibling rather
  // than being wrapped into this one.
  mount(panel,
    el('section', { class: 'panel' }, [
      panelHead('Documents'),
      drive,
      buildUpload(ctx, project, () => load()),
      notice,
      listWrap,
    ]),
    clientDocsHost);
  await load();

  // Documents filed against the client record itself, surfaced here so both
  // attachment types are visible from the project too. Staff-only: the query
  // below returns zero rows for a client under RLS anyway, but not asking at
  // all saves them the round trip — and the panel never flickers into view.
  if (ctx.isAdmin && project.clients && project.clients.id) {
    await loadClientDocs();
  }

  async function loadClientDocs() {
    let docs;
    try {
      const { data, error } = await supabase
        .from('documents')
        .select(DOC_SELECT)
        .eq('client_id', project.clients.id)
        .order('created_at', { ascending: false });
      if (error) throw error;
      docs = data || [];
    } catch (error) {
      // The project's own list is this tab's job; the client panel is a bonus
      // for staff, so a failure here costs the panel rather than the tab.
      toast(errorMessage(error), 'error');
      return;
    }

    // Nothing filed, nothing rendered: the common case stays a clean tab.
    if (!docs.length) {
      mount(clientDocsHost);
      return;
    }

    mount(clientDocsHost, el('section', { class: 'panel doc-client-panel' }, [
      el('div', { class: 'panel__head' }, [
        el('h2', { text: 'Client documents' }),
        el('div', { class: 'page-head__actions' }, [
          el('a', {
            class: 'btn btn--ghost btn--tiny',
            href: `/portal/client/?id=${encodeURIComponent(project.clients.id)}`,
            text: 'Client record',
          }),
        ]),
      ]),
      el('p', {
        class: 'progress__label',
        text: `Filed under ${project.clients.name} rather than this project. Only staff see these.`,
      }),
      el('div', { class: 'doc-list' }, docs.map((doc) => docRow(doc, ctx, loadClientDocs))),
    ]));
  }

  async function load() {
    let docs;
    try {
      const { data, error } = await supabase
        .from('documents')
        .select(DOC_SELECT)
        .eq('project_id', project.id)
        .order('created_at', { ascending: false });
      if (error) throw error;
      docs = data || [];
    } catch (error) {
      // "Please reload the page" asks a client to fix our problem with the
      // bluntest tool they have, and throws away everything else on the
      // screen to do it. load() is right here; offer that instead. Same shape
      // as project.js's tab failure, deliberately.
      toast(errorMessage(error), 'error');
      mount(listWrap, el('div', {}, [
        el('p', { class: 'notice notice--error', text: errorMessage(error, 'Could not load your documents.') }),
        el('button', {
          class: 'btn btn--ghost btn--small',
          type: 'button',
          text: 'Try again',
          onclick: () => load(),
        }),
      ]));
      return;
    }

    // Anything waiting on a signature floats up: it is the one row a client
    // must not have to scroll for. sort() is stable, so newest-first holds
    // inside each group.
    docs.sort((a, b) => Number(isAwaiting(b)) - Number(isAwaiting(a)));

    const waiting = docs.filter(isAwaiting).length;
    notice.hidden = waiting === 0;
    if (waiting) {
      notice.textContent = ctx.isAdmin
        ? `${waiting} document${waiting === 1 ? '' : 's'} ${waiting === 1 ? 'is' : 'are'} waiting on the client.`
        : `${waiting} document${waiting === 1 ? '' : 's'} need${waiting === 1 ? 's' : ''} your approval.`;
    }

    if (!docs.length) {
      mount(listWrap, el('p', { class: 'empty', text: emptyText(ctx) }));
      return;
    }

    mount(listWrap, el('div', { class: 'doc-list' }, docs.map((doc) => docRow(doc, ctx, load))));
  }
}

function emptyText(ctx) {
  return ctx.isAdmin
    ? 'Nothing here yet. Proposals, contracts, invoices and finished deliverables all live on this tab.'
    : 'Nothing here yet. Proposals, contracts and finished files will appear here as we go — '
      + 'and you can send us logos, copy or photos with the form above.';
}

// Upload
// ---------------------------------------------------------------------------

function buildUpload(ctx, project, onDone) {
  const fileId = nextId('doc-file');
  const kindId = nextId('doc-kind');

  const fileInput = el('input', { type: 'file', id: fileId, name: 'file' });

  const kindSelect = el('select', { id: kindId, name: 'kind' }, DOC_KINDS.map((kind) => el('option', {
    value: kind,
    text: titleCase(kind),
    selected: kind === (ctx.isAdmin ? 'deliverable' : 'asset'),
  })));

  const approvalBox = ctx.isAdmin
    ? el('input', { type: 'checkbox', id: nextId('doc-approval'), name: 'needs_approval' })
    : null;

  const button = el('button', { class: 'btn btn--small', type: 'submit', text: 'Upload' });
  const status = el('p', { class: 'progress__label', hidden: true });

  const form = el('form', { class: 'upload' }, [
    el('div', { class: 'form-field' }, [
      el('label', { for: fileId, text: ctx.isAdmin ? 'Choose a file' : 'Send us a file — logos, copy, photos' }),
      fileInput,
    ]),
    el('div', { class: 'form-field' }, [
      el('label', { for: kindId, text: 'Kind' }),
      kindSelect,
    ]),
    el('div', {}, [
      el('div', { class: 'btn-row' }, [
        approvalBox ? el('label', { class: 'check', for: approvalBox.id }, [approvalBox, 'Needs client approval']) : null,
        button,
      ]),
      status,
    ]),
    // Below the row, not inside the file column — a hint in one cell makes it
    // taller than its neighbours and the bottom-aligned controls fall out of
    // line (.upload__note spans the columns).
    el('span', {
      class: 'progress__label upload__note',
      text: `One file at a time, up to ${fmtBytes(MAX_UPLOAD_BYTES)}.`,
    }),
  ]);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();

    const file = fileInput.files && fileInput.files[0];
    if (!file) {
      toast('Choose a file first.', 'error');
      fileInput.focus();
      return;
    }

    if (file.size > MAX_UPLOAD_BYTES) {
      toast(
        `${file.name} is ${fmtBytes(file.size)} — the limit is ${fmtBytes(MAX_UPLOAD_BYTES)}. `
        + 'Send us a download link instead and we will pull it down.',
        'error',
      );
      return;
    }

    const path = `${project.id}/${crypto.randomUUID()}-${safeName(file.name)}`;

    button.disabled = true;
    button.textContent = 'Uploading…';
    status.hidden = false;
    status.textContent = `Uploading ${file.name} (${fmtBytes(file.size)})…`;

    try {
      const upload = await supabase.storage
        .from(DOCUMENTS_BUCKET)
        .upload(path, file, { contentType: file.type || 'application/octet-stream' });
      if (upload.error) throw upload.error;

      status.textContent = 'Saving…';

      const { error } = await supabase.from('documents').insert({
        project_id: project.id,
        name: file.name,
        storage_path: path,
        kind: kindSelect.value,
        size_bytes: file.size,
        mime_type: file.type || null,
        uploaded_by: ctx.profile.id,
        // RLS refuses this from a client anyway; keep the payload honest.
        needs_approval: Boolean(approvalBox && approvalBox.checked),
      });

      // An object with no row is invisible in the UI but still bills us for
      // storage forever, so clean up before surfacing the failure.
      if (error) {
        try {
          await supabase.storage.from(DOCUMENTS_BUCKET).remove([path]);
        } catch (cleanupError) {
          // Nothing useful to tell the user here; the insert error is the story.
        }
        throw error;
      }

      // Unmistakable: filing a document is work on this project.
      if (ctx.isAdmin) signalWork({ projectId: project.id, projectName: project.name });

      form.reset();
      toast('Uploaded', 'ok');
      await onDone();
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
      button.disabled = false;
      button.textContent = 'Upload';
      status.hidden = true;
      status.textContent = '';
    }
  });

  return form;
}

// Rows
// ---------------------------------------------------------------------------

/**
 * One document, with download and (for staff) delete. Shared with the client
 * record page, which passes `attachment` — a node naming where the document is
 * filed — so a mixed list can say which rows belong to the client record and
 * which to a project.
 *
 * A signed contract is the exception, and it is the same row with the actions
 * taken away: open, read, download, and nothing else, for both sides. See the
 * file header.
 */
export function docRow(doc, ctx, reload, { attachment } = {}) {
  const who = uploaderName(doc, ctx);
  const signed = isSignedContract(doc);

  const meta = el('p', { class: 'doc-row__meta' }, [
    attachment || null,
    // The badge does the work the missing buttons would otherwise leave to
    // guesswork: a row with no Delete beside a row that has one reads as a bug
    // until something says why.
    signed ? el('span', { class: 'pill pill--green', text: 'Signed' }) : null,
    el('span', { class: 'pill', text: titleCase(doc.kind) }),
    doc.size_bytes ? el('span', { text: fmtBytes(doc.size_bytes) }) : null,
    el('span', { text: `Added ${fmtDate(doc.created_at)}` }),
    who ? el('span', { text: who }) : null,
    signed ? el('span', { text: 'Review-only' }) : null,
  ]);

  const actions = el('div', { class: 'btn-row' }, signed
    ? [downloadButton(doc)]
    : [
      downloadButton(doc),
      isAwaiting(doc) ? approveButton(doc, reload) : null,
      doc.approved_at ? el('span', { class: 'pill pill--green', text: `Approved ${fmtDate(doc.approved_at)}` }) : null,
      ctx.isAdmin ? deleteButton(doc, reload) : null,
    ]);

  return el('div', { class: isAwaiting(doc) && !signed ? 'doc-row doc-row--awaiting' : 'doc-row' }, [
    el('div', {}, [
      el('p', { class: 'doc-row__name', text: doc.name }),
      meta,
    ]),
    actions,
  ]);
}

function downloadButton(doc) {
  const button = el('button', {
    class: 'btn btn--ghost btn--small',
    type: 'button',
    text: 'Download',
    'aria-label': `Download ${doc.name}`,
  });

  button.addEventListener('click', async () => {
    button.disabled = true;
    button.textContent = 'Opening…';
    try {
      // `download` makes storage answer with Content-Disposition: attachment,
      // which both keeps the original filename and stops a client-uploaded
      // .html from ever executing on our storage origin.
      const { data, error } = await supabase.storage
        .from(docBucket(doc))
        .createSignedUrl(doc.storage_path, 60, { download: doc.name });
      if (error) throw error;

      const link = el('a', { href: data.signedUrl, download: doc.name, rel: 'noopener' });
      document.body.append(link);
      link.click();
      link.remove();
    } catch (error) {
      toast(
        isMissingObject(error)
          ? `${doc.name} is no longer in storage. Ask us to send it again.`
          : errorMessage(error),
        'error',
      );
    } finally {
      button.disabled = false;
      button.textContent = 'Download';
    }
  });

  return button;
}

function approveButton(doc, reload) {
  const button = el('button', {
    class: 'btn btn--small',
    type: 'button',
    text: 'Approve',
    'aria-label': `Approve ${doc.name}`,
  });

  button.addEventListener('click', async () => {
    // Not `danger`, though a client cannot take it back: approve_document pins
    // the timestamp with coalesce(approved_at, now()), so only an admin can
    // clear it. Destructive styling is for destruction — a red button on the
    // one act we are asking the client to perform reads as a warning against
    // doing it.
    const ok = await confirmModal({
      title: `Approve ${doc.name}?`,
      body: "We'll treat this as your sign-off.",
      confirmLabel: 'Approve document',
    });
    if (!ok) return;

    button.disabled = true;
    button.textContent = 'Approving…';
    try {
      const { error } = await supabase.rpc('approve_document', { doc_id: doc.id });
      if (error) throw error;
      toast('Approved — thank you', 'ok');
      await reload();
    } catch (error) {
      toast(errorMessage(error), 'error');
      button.disabled = false;
      button.textContent = 'Approve';
    }
  });

  return button;
}

function deleteButton(doc, reload) {
  const button = el('button', {
    class: 'btn btn--danger btn--small',
    type: 'button',
    text: 'Delete',
    'aria-label': `Delete ${doc.name}`,
  });

  button.addEventListener('click', async () => {
    const ok = await confirmModal({
      title: `Delete ${doc.name}?`,
      body: 'This cannot be undone.',
      confirmLabel: 'Delete document',
      tone: 'danger',
    });
    if (!ok) return;

    button.disabled = true;
    button.textContent = 'Deleting…';
    try {
      // Object first — the row holds the only copy of the path. A missing
      // object must not strand the row that points at it.
      const removal = await supabase.storage.from(docBucket(doc)).remove([doc.storage_path]);
      if (removal.error && !isMissingObject(removal.error)) throw removal.error;

      const { error } = await supabase.from('documents').delete().eq('id', doc.id);
      if (error) throw error;

      toast('Deleted', 'ok');
      await reload();
    } catch (error) {
      toast(errorMessage(error), 'error');
      button.disabled = false;
      button.textContent = 'Delete';
    }
  });

  return button;
}
