// ---------------------------------------------------------------------------
// The person modal — one form for every door into an account.
//
// Every way to reach it has to be the same form, or "give someone access"
// means something subtly different depending on which screen you happened to
// be standing on:
//
//   Admin → People → Add a person          create, preset to staff
//   Admin → People → click a name          edit
//   Client → People → Add a person         create, preset to that client
//   Client → People → click a name         edit, for that client's user
//   Client record → Give portal access     create, prefilled from the contact
//   Client record → the Portal user pill   edit, for the account behind it
//
// It lived inside admin.js until the client record needed it too. Nothing here
// knows which screen called it: the caller passes the clients list and what it
// wants preset, and gets back whether anything was saved and whether a password
// was assigned — the one thing that has to be shown once and cannot be looked
// up again.
//
// Accounts go through the front door (CLAUDE.md rule 7): create and any change
// to email or password run through netlify/functions/admin-users.js, because
// those live in auth rather than in profiles. Profile columns are written
// directly, under RLS.
//
// An address that already signs in is the one create this form cannot do, and
// it is not an error — it is somebody who works for two clients, or somebody
// whose account was made on the wrong page. One email is one account, so the
// answer is to add the account that exists rather than to make a second one:
// the form hands off to the same link question Give portal access asks
// (js/portal/promote-contact.js), or, with no client to add them to, offers
// their record instead.
//
// The Clients boxes take several ticks, because one login can open several
// companies: the database keeps a home (profiles.client_id) plus membership
// rows (profile_clients), and js/portal/person-clients.js turns the ticks
// into that shape — the home stays put while it is still ticked, extra ticks
// become rows, and unticking a row removes it, exactly what Unlink does from
// the People panel. The form never says "home" out loud; which company wears
// the label is bookkeeping, not access.
// ---------------------------------------------------------------------------

import { supabase, errorMessage } from './client.js';
import { el, formModal, modalShell, toast } from './ui.js';
import { callAdminUsers, passwordFields, MIN_PASSWORD } from './accounts.js';
import { findProfileByEmail, offerLinkToClient, membershipIds } from './promote-contact.js';
import { selectedClientIds, planClientChange } from './person-clients.js';

const ROLE_OPTIONS = [
  { value: 'client', label: 'Client' },
  { value: 'admin', label: 'Admin (staff)' },
];

/** "Dana Whitfield" → the two boxes the form shows. Everything downstream
 *  still stores one full_name; the split is a courtesy at the keyboard. */
export function splitName(fullName) {
  const name = String(fullName || '').trim();
  if (!name) return { first: '', last: '' };
  const space = name.indexOf(' ');
  if (space === -1) return { first: name, last: '' };
  return { first: name.slice(0, space), last: name.slice(space + 1).trim() };
}

export function joinName(first, last) {
  return [first, last]
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join(' ') || null;
}

/**
 * Open it.
 *
 *   person        the profile being edited, or null to create one
 *   clients       [{ id, name }] for the Clients boxes
 *   selfId        the signed-in profile's id, so nobody demotes themselves
 *   presetClientId  a client to start ticked (the client record's own id)
 *   presetRole    the role to start on — Admin's Add a person passes 'admin',
 *                 because a client account made there is on the wrong page
 *   prefill       { name, email } when creating from a contact row
 *
 * Resolves null if it was cancelled, otherwise
 * { handoff, editing, linkedExisting, warning }:
 *
 *   handoff        { email, password } when a password was assigned here, and
 *                  the caller's to display once. Null otherwise.
 *   editing        whether an existing account was edited rather than created.
 *   linkedExisting set when the address turned out to already have an account
 *                  and that account was added to the client instead. Nothing
 *                  was created, and the link flow has already said so — the
 *                  caller should not announce an account it did not make.
 *   warning        a sentence the caller should toast: the save stood, but a
 *                  side write (linking extra clients onto a fresh account)
 *                  did not, and somebody has to hear about it.
 *
 * `allowDelete` hides the destructive button. The client record passes false
 * for a login whose home is another company: from that page "remove them" means
 * remove them from THIS client, which is Unlink on their row — deleting would
 * destroy a sign-in that half belongs to somebody else's project, and the two
 * are one click apart. Admin → People, where an account is the subject rather
 * than a guest, leaves it on.
 */
export async function openPersonForm({
  person = null,
  clients = [],
  selfId = null,
  presetClientId = null,
  presetRole = null,
  prefill = null,
  allowDelete = true,
} = {}) {
  const editing = Boolean(person);
  // Losing your own admin rights is a one-way door from inside the browser:
  // only another admin (or SQL) can undo it.
  const isSelf = editing && person.id === selfId;
  const name = splitName(editing ? person.full_name : (prefill && prefill.name) || '');

  // What the login already holds, read before the form draws: the Clients
  // boxes cannot start right without it, and the save computes its adds and
  // removals against it. Refusing to open beats opening wrong — a form that
  // could not see a membership would read its absent tick as an untick and
  // quietly take access away on save.
  let memberIds = [];
  if (editing) {
    try {
      memberIds = await membershipIds(person.id);
    } catch (error) {
      toast(errorMessage(error), 'error');
      return null;
    }
  }

  const offeredIds = (clients || []).map((client) => client.id);
  const startTicked = selectedClientIds({
    homeId: editing ? person.client_id : presetClientId,
    memberIds,
    offeredIds,
  });

  // Set when a password was assigned, so the caller can show it once. It
  // carries who the account is for as well as the credentials: the client
  // record builds a welcome email off this, and a welcome belongs only to a
  // brand-new client account — never to a staff one, and never to a reset.
  let handoff = null;

  // Set when the account was destroyed, so the caller refreshes and says so
  // rather than announcing a save that did not happen.
  let deleted = false;

  // Set when the save stood but a side write did not — the caller toasts it.
  let warning = null;

  // Set when the submitted email turns out to already have an account: the
  // profile behind it, and the client the form was pointing at. Both are read
  // after this modal closes, because what happens next is another dialog and
  // two cannot be open at once.
  let existing = null;
  let existingClientId = null;

  const result = await formModal({
    title: editing
      ? (person.full_name || person.email || 'Edit person')
      : 'Add a person',
    submitLabel: editing ? 'Save person' : 'Create account',
    intro: editing
      ? 'Everything here applies the moment you save. Devices they are '
        + 'already signed in on stay signed in.'
      : 'This creates the account and sets its password straight away. They '
        + 'can sign in the moment you send them the details — there is nothing '
        + 'for them to activate.',
    fields: [
      {
        name: 'first_name',
        label: 'First name',
        type: 'text',
        value: name.first,
        placeholder: 'Dana',
      },
      {
        name: 'last_name',
        label: 'Last name',
        type: 'text',
        value: name.last,
        placeholder: 'Whitfield',
        hint: 'Together these are the byline on everything they post.',
      },
      {
        name: 'email',
        label: 'Email',
        type: 'email',
        required: true,
        value: editing ? person.email || '' : (prefill && prefill.email) || '',
        placeholder: 'name@company.com',
        hint: 'The address they sign in with.',
      },
      {
        name: 'phone',
        label: 'Phone',
        type: 'tel',
        value: editing ? person.phone || '' : (prefill && prefill.phone) || '',
        placeholder: '(555) 010-4477',
        hint: 'For staff, this is what a client\'s Call and Text buttons dial '
            + 'on the project team panel — so use the number they answer.',
      },
      {
        name: 'role',
        label: 'Role',
        type: 'select',
        value: editing ? person.role : (presetRole || 'client'),
        options: ROLE_OPTIONS,
        disabled: isSelf,
        hint: isSelf ? 'Another admin has to change your own role.' : undefined,
      },
      {
        name: 'client_ids',
        label: 'Clients',
        type: 'checkboxes',
        value: startTicked,
        options: (clients || []).map((client) => ({ value: client.id, label: client.name })),
        hint: 'Tick every client this login opens — one sign-in can hold '
            + 'several. A client account needs at least one; staff see every '
            + 'client and need none.',
      },
      ...(editing ? [{
        name: 'joined',
        label: 'Joined',
        type: 'date',
        required: true,
        value: String(person.created_at || '').slice(0, 10),
      }] : []),
      ...passwordFields({ optional: editing }),
    ],
    onSubmit: async (values) => {
      const role = isSelf ? person.role : values.role;
      // The ticks, turned into what has to be written: which client is the
      // home column and which are membership rows. On a create the preset
      // client stays home even when an alphabetically earlier tick joins it —
      // the welcome email and the People label follow the home.
      const plan = planClientChange({
        checkedIds: values.client_ids,
        homeId: editing ? (person.client_id || null) : (presetClientId || null),
        memberIds,
        offeredIds,
        role,
      });
      if (plan.error) throw new Error(plan.error);

      if (!editing) {
        const email = values.email.trim().toLowerCase();

        // Ask who owns the address before spending a round trip on a create
        // that would only come back 409. Finding somebody is not a failure:
        // it is the add-them-instead case, and it continues once this form
        // has closed.
        existing = await findProfileByEmail(email);
        if (existing) {
          existingClientId = plan.home;
          return;
        }

        const created = await callAdminUsers({
          action: 'create',
          email,
          full_name: joinName(values.first_name, values.last_name),
          role,
          client_id: plan.home,
          password: values.password,
        });
        // The phone lives on the profile, which handle_new_user() has already
        // written by the time create returns — admin-users only handles what
        // lives in auth. A failure here costs the number, not the account, and
        // the edit form sets it again; do not fail a created account over it.
        if (values.phone && created && created.user_id) {
          const { error } = await supabase
            .from('profiles')
            .update({ phone: values.phone })
            .eq('id', created.user_id);
          if (error) console.error('person-form: account created, phone not saved', error);
        }
        // Extra ticks beyond the home ride along after the create on the same
        // terms as the phone: they live in profile_clients rather than auth,
        // and a failure costs links the edit form can re-tick, never the
        // account. Unlike the phone it decides what they can see, so it is
        // said out loud rather than only logged.
        if (plan.add.length && created && created.user_id) {
          const { error } = await supabase.from('profile_clients').insert(
            plan.add.map((clientId) => ({
              profile_id: created.user_id,
              client_id: clientId,
              added_by: selfId,
            })));
          if (error) {
            console.error('person-form: account created, extra clients not linked', error);
            warning = 'The account was created, but linking the other '
              + `${plan.add.length === 1 ? 'client' : 'clients'} failed — `
              + 'open the person and tick them again.';
          }
        }
        handoff = {
          email,
          password: values.password,
          role,
          client_id: plan.home,
          full_name: joinName(values.first_name, values.last_name),
          created: true,
        };
        return;
      }

      // Check the optional password before touching anything, so a typo here
      // cannot leave the edit half-applied.
      if (values.password && values.password.length < MIN_PASSWORD) {
        throw new Error(`A new password needs at least ${MIN_PASSWORD} characters.`);
      }

      const patch = {};

      const fullName = joinName(values.first_name, values.last_name);
      if (fullName !== (person.full_name || null)) patch.full_name = fullName;
      if ((values.phone || null) !== (person.phone || null)) patch.phone = values.phone || null;
      if (!isSelf && role !== person.role) patch.role = role;
      if (plan.home !== (person.client_id || null)) patch.client_id = plan.home;

      if (values.joined && values.joined !== String(person.created_at || '').slice(0, 10)) {
        // Noon UTC, so the date-only slice every display takes lands on this
        // date whatever timezone the row is read back in.
        patch.created_at = `${values.joined}T12:00:00Z`;
      }

      if (Object.keys(patch).length) {
        const { error } = await supabase.from('profiles').update(patch).eq('id', person.id);
        if (error) throw new Error(errorMessage(error));
      }

      // The membership rows, after the home column so a promoted tick is home
      // before its old row goes. Deltas only — rows the form did not touch
      // are not rewritten. A failure here keeps the form open, and a retry is
      // safe: the delete of a gone row matches nothing, and a duplicate
      // insert is the two-admins-in-the-same-minute case below.
      if (plan.remove.length) {
        const { error } = await supabase
          .from('profile_clients')
          .delete()
          .eq('profile_id', person.id)
          .in('client_id', plan.remove);
        if (error) throw new Error(errorMessage(error));
      }
      if (plan.add.length) {
        const { error } = await supabase.from('profile_clients').insert(
          plan.add.map((clientId) => ({
            profile_id: person.id,
            client_id: clientId,
            added_by: selfId,
          })));
        // Two admins linking the same person in the same minute is a success,
        // not a failure — the second insert finds the row already there.
        if (error && !/duplicate|unique/i.test(error.message || '')) {
          throw new Error(errorMessage(error));
        }
      }

      const email = values.email.toLowerCase();
      if (email !== String(person.email || '').toLowerCase()) {
        await callAdminUsers({ action: 'set-email', user_id: person.id, email });
      }

      if (values.password) {
        await callAdminUsers({ action: 'set-password', user_id: person.id, password: values.password });
        // created: false — this is a reset on an account that already exists,
        // and "Welcome to the client portal!" is the wrong thing to send
        // somebody who has been signing in for a year.
        handoff = {
          email,
          password: values.password,
          role,
          client_id: plan.home,
          full_name: fullName,
          created: false,
        };
      }
    },

    // Deleting a sign-in. Offered only when editing an account that is not
    // your own — you cannot delete yourself, and the server refuses it too
    // (admin-users), because a browser check is a convenience, not a boundary.
    //
    // formModal's default ("Delete account? This cannot be undone.") is too
    // thin for this one: what makes it irreversible is not the row but the
    // byline, so the dialog names the person and says what happens to the
    // record they leave behind. Declining leaves the form open, which is the
    // point — closing it would look like the delete had happened.
    onDelete: editing && !isSelf && allowDelete
      ? async () => {
        await callAdminUsers({ action: 'delete', user_id: person.id });
        deleted = true;
      }
      : null,
    deleteLabel: 'Delete account',
    // Built only when there is somebody to delete, and the guard is the whole
    // point rather than defensive habit: this object is an *argument*, so its
    // template literal runs when the call is made, not when the delete button
    // is pressed. onDelete above is null on a create, so nothing here would
    // ever be shown — but `person.full_name` on a null person still threw, and
    // Add a person died before the form opened. A value that reads a thing the
    // feature it belongs to is disabled for has to be built lazily or not at
    // all; every other use of `person` in this file goes through `editing` for
    // exactly this reason.
    confirmDelete: editing ? {
      title: `Delete ${person.full_name || person.email || 'this account'}?`,
      body: [
        'They lose their sign-in immediately, on every device.',
        'Everything they posted stays — messages, notes, files — but their '
          + 'name comes off it, and anything they approved will show no '
          + 'approver. This cannot be undone.',
      ],
    } : undefined,
  });

  if (!result) return null;
  if (result === 'deleted' || deleted) return { deleted: true, editing };

  if (existing) {
    return resolveExisting({
      existing,
      clientId: existingClientId,
      typedName: joinName(result.first_name, result.last_name),
      clients,
      selfId,
    });
  }

  return { handoff, editing, warning };
}

/**
 * The submitted address already signs in. What to offer depends on whether
 * there is a client to add them to:
 *
 *   a client   the link question — one login, both companies. This is the
 *              common one, and the reason the old error was wrong: the person
 *              is real, the client is right, and the only thing that could
 *              not happen was a second account for the same email.
 *   no client  nothing to add them to (a staff account, or no box ticked), so
 *              offer the one thing that does help: their record, opened in
 *              this same form — where the Clients boxes can do the linking.
 */
async function resolveExisting({ existing, clientId, typedName, clients, selfId }) {
  const target = (clients || []).find((row) => row.id === clientId);

  if (target) {
    const outcome = await offerLinkToClient({
      existing,
      name: typedName,
      client: target,
      addedBy: selfId,
    });
    // A no, a staff account, somebody already in — the flow has said which.
    return outcome ? { handoff: null, editing: false, linkedExisting: true } : null;
  }

  if (!await confirmOpenExisting(existing)) return null;
  return openPersonForm({ person: existing, clients, selfId });
}

/** Whose address it is, and the way on from here. Shown only when there is no
 *  client in the form to add them to — otherwise the link question, which can
 *  actually finish the job, is the better dialog to be looking at. */
function confirmOpenExisting(existing) {
  return new Promise((resolve) => {
    const shell = modalShell({ title: 'That email already signs in', onClose: resolve });

    shell.body.append(
      el('p', {
        text: existing.full_name
          ? `${existing.email} is ${existing.full_name}'s account`
            + `${existing.role === 'admin' ? ', a staff account' : ''}.`
          : `${existing.email} already has an account`
            + `${existing.role === 'admin' ? ', a staff one' : ''}.`,
      }),
      el('p', {
        text: 'Nothing was created — one address is one account. Open it to '
            + 'change their name, role, or password — or to tick more clients '
            + 'onto the one login.',
      }),
    );

    shell.foot.append(
      el('button', {
        class: 'btn',
        type: 'button',
        text: 'Open their account',
        onclick: () => shell.close(true),
      }),
      el('button', {
        class: 'btn btn--ghost',
        type: 'button',
        text: 'Cancel',
        onclick: () => shell.close(null),
      }),
    );

    shell.open();
  });
}
