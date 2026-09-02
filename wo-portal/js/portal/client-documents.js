// ---------------------------------------------------------------------------
// Documents panel on the client record page.
//
// The filing cabinet for one client: the signed paperwork, the tax forms, the
// PDFs that need finding in a year. Each upload is attached either to the
// client record itself or to one of their projects — that choice is the whole
// feature — and the list shows every document either way, labelled with where
// it lives. The project side of the same picture is the Documents tab, which
// shows its project's files and, to staff, the client-filed ones.
//
// Attachment decides who can see it. A project document lands on that
// project's Documents tab, which the client reads too; a client document is
// staff-only, like the contact sheet and the notes feed. The upload form says
// so, because the difference is invisible at the moment of choosing.
//
// PDFs only, by design: this is for finished, important documents, and those
// are PDFs. The project tab still takes anything — logos, copy and photos
// keep flowing through it.
//
// Signed contracts land in this list the moment a client adopts one — the
// signing function files them here, attached to the client — and they render
// review-only, with a download and nothing else. That treatment is not
// implemented twice: it rides in on DOC_SELECT and docRow() from documents.js,
// which is exactly why both are imported from there rather than restated. See
// that file's header for how a signed row is recognised without a query per
// row.
// ---------------------------------------------------------------------------

import { supabase, errorMessage } from './client.js';
import { CLIENT_DOCUMENTS_BUCKET, DOCUMENTS_BUCKET } from './config.js';
import { el, mount, toast, fmtBytes, titleCase } from './ui.js';
import { safeName, MAX_UPLOAD_BYTES } from './files.js';
import { DOC_KINDS, DOC_SELECT, docRow } from './documents.js';

/** The file input's accept attribute is a hint a picker may ignore, so the
 *  rule is enforced here too: a PDF by declared type, or — some platforms
 *  leave type blank — by extension. */
function isPdf(file) {
  if (file.type) return file.type === 'application/pdf';
  return /\.pdf$/i.test(file.name);
}

export async function renderClientDocuments(panel, ctx, client, projects) {
  const listWrap = el('div', {}, [el('p', { class: 'skeleton', text: 'Loading documents…' })]);
  const projectNames = new Map(projects.map((project) => [project.id, project.name]));

  mount(panel, buildUpload(), listWrap);
  await load();

  async function load() {
    let docs;
    try {
      // One list, both attachment types: the client's own documents and every
      // document on their projects. The ids come straight off rows this page
      // already loaded, so interpolating them into the filter is safe.
      let query = supabase.from('documents').select(DOC_SELECT);
      const ids = projects.map((project) => project.id);
      query = ids.length
        ? query.or(`client_id.eq.${client.id},project_id.in.(${ids.join(',')})`)
        : query.eq('client_id', client.id);

      const { data, error } = await query.order('created_at', { ascending: false });
      if (error) throw error;
      docs = data || [];
    } catch (error) {
      // See documents.js: load() is in scope, so a retry beats asking the
      // client to reload the whole page.
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
        text: 'Nothing filed yet. The signed agreement, the W-9, the PDFs you '
            + 'will need to find in a year — this is where they live.',
      }));
      return;
    }

    mount(listWrap, el('div', { class: 'doc-list' },
      docs.map((doc) => docRow(doc, ctx, load, { attachment: attachmentPill(doc) }))));
  }

  /** Where the document is filed, as the first thing its row says. Project
   *  rows link through to the tab the client sees. */
  function attachmentPill(doc) {
    if (doc.client_id) {
      return el('span', { class: 'pill pill--blue', text: 'Client' });
    }
    return el('a', {
      class: 'pill',
      href: `/portal/project/?id=${encodeURIComponent(doc.project_id)}#documents`,
      text: projectNames.get(doc.project_id) || 'Project',
    });
  }

  // Upload
  // -------------------------------------------------------------------------

  function buildUpload() {
    const fileInput = el('input', {
      type: 'file',
      id: 'client-doc-file',
      name: 'file',
      accept: 'application/pdf,.pdf',
    });

    const attachSelect = el('select', { id: 'client-doc-attach', name: 'attach' }, [
      el('option', { value: 'client', text: `This client — ${client.name}` }),
      ...projects.map((project) => el('option', {
        value: project.id,
        text: `Project — ${project.name}`,
      })),
    ]);

    const kindSelect = el('select', { id: 'client-doc-kind', name: 'kind' },
      DOC_KINDS.map((kind) => el('option', {
        value: kind,
        text: titleCase(kind),
        // The things filed here are overwhelmingly the signed ones.
        selected: kind === 'contract',
      })));

    const button = el('button', { class: 'btn btn--small', type: 'submit', text: 'Upload' });
    const status = el('p', { class: 'progress__label', hidden: true });

    const form = el('form', { class: 'upload upload--filing' }, [
      el('div', { class: 'form-field' }, [
        el('label', { for: 'client-doc-file', text: 'Choose a PDF' }),
        fileInput,
      ]),
      el('div', { class: 'form-field' }, [
        el('label', { for: 'client-doc-attach', text: 'Attach to' }),
        attachSelect,
      ]),
      el('div', { class: 'form-field' }, [
        el('label', { for: 'client-doc-kind', text: 'Kind' }),
        kindSelect,
      ]),
      el('div', {}, [
        el('div', { class: 'btn-row' }, [button]),
        status,
      ]),
      // Everything the form has to say, said once, under all of it. A hint
      // inside any one column makes that cell taller than its neighbours and
      // knocks the bottom-aligned row out of line, so the columns hold a
      // label and a control each and nothing else (.upload__note spans them).
      el('span', {
        class: 'progress__label upload__note',
        text: `PDFs only for now, up to ${fmtBytes(MAX_UPLOAD_BYTES)}. `
            + 'A project document shows on that project\'s Documents tab, which '
            + `${client.name} can read. A client document stays staff-only.`,
      }),
    ]);

    form.addEventListener('submit', async (event) => {
      event.preventDefault();

      const file = fileInput.files && fileInput.files[0];
      if (!file) {
        toast('Choose a PDF first.', 'error');
        fileInput.focus();
        return;
      }

      if (!isPdf(file)) {
        toast(`${file.name} is not a PDF. Only PDFs are filed here for now.`, 'error');
        return;
      }

      if (file.size > MAX_UPLOAD_BYTES) {
        toast(
          `${file.name} is ${fmtBytes(file.size)} — the limit is ${fmtBytes(MAX_UPLOAD_BYTES)}.`,
          'error',
        );
        return;
      }

      const toClient = attachSelect.value === 'client';
      const bucket = toClient ? CLIENT_DOCUMENTS_BUCKET : DOCUMENTS_BUCKET;
      // The first path segment is what the storage policies check, so it has
      // to be the id of the thing the document is attached to.
      const folder = toClient ? client.id : attachSelect.value;
      const path = `${folder}/${crypto.randomUUID()}-${safeName(file.name)}`;

      button.disabled = true;
      button.textContent = 'Uploading…';
      status.hidden = false;
      status.textContent = `Uploading ${file.name} (${fmtBytes(file.size)})…`;

      try {
        const upload = await supabase.storage
          .from(bucket)
          .upload(path, file, { contentType: file.type || 'application/pdf' });
        if (upload.error) throw upload.error;

        status.textContent = 'Saving…';

        const { error } = await supabase.from('documents').insert({
          client_id: toClient ? client.id : null,
          project_id: toClient ? null : attachSelect.value,
          name: file.name,
          storage_path: path,
          kind: kindSelect.value,
          size_bytes: file.size,
          mime_type: file.type || 'application/pdf',
          uploaded_by: ctx.profile.id,
          needs_approval: false,
        });

        // An object with no row is invisible in the UI but still bills for
        // storage forever, so clean up before surfacing the failure.
        if (error) {
          try {
            await supabase.storage.from(bucket).remove([path]);
          } catch (cleanupError) {
            // Nothing useful to tell the user here; the insert error is the story.
          }
          throw error;
        }

        form.reset();
        toast('Uploaded', 'ok');
        await load();
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
}
