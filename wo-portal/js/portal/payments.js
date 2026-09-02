// ---------------------------------------------------------------------------
// Recording that money arrived.
//
// Shared by the invoice list and the invoice form, because "mark this paid" is
// something you reach for from both and there should be exactly one thing that
// happens when you do.
//
// It replaces a shortcut. Before this, marking an invoice paid wrote a number
// and a timestamp onto the invoice itself and that was the whole record — which
// could not say whether $2,000 was one payment or four, could not say which
// account it landed in, and left nothing for a bank reconciliation to tick off.
// Now a payment is a row: an amount, a date, a method, and the account it went
// into. The invoice's own paid_cents and status are maintained from it by a
// trigger, so the invoice list keeps reading exactly as it did.
//
// The ledger side is not this file's business either. Inserting the row posts
// it — debit the account it landed in, credit Accounts receivable — through the
// trigger in supabase/schema.sql. Doing it here would mean a payment recorded
// any other way silently missed the books.
// ---------------------------------------------------------------------------

import { errorMessage } from './client.js';
import { el, formModal, fmtDate, toast, busy, confirmModal } from './ui.js';
import { formatMoney, parseMoney } from './sow-fees.js';
import { invoiceLabel } from './invoice-catalog.js';
import {
  CASH_SUBTYPES,
  PAYMENT_METHODS,
  accountLabel,
  methodLabel,
} from './ledger-catalog.js';
import {
  deletePayment,
  loadAccounts,
  loadSettings,
  paymentsForInvoice,
  recordPayment,
} from './ledger-data.js';

/**
 * The accounts money can arrive into, and which one to offer first.
 *
 * Loaded once per screen and passed in, rather than fetched inside the modal:
 * the list is the same for every invoice on the page, and a dialog that opens
 * after a round trip feels broken on a slow connection.
 */
export async function paymentContext() {
  const [accounts, settings] = await Promise.all([loadAccounts(), loadSettings()]);

  const deposits = accounts.filter((row) => (
    !row.archived_at && CASH_SUBTYPES.includes(row.subtype)
  ));

  return { accounts, deposits, settings };
}

function todayIso() {
  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
}

/**
 * Record one payment against one invoice.
 *
 * Defaults to the whole outstanding balance, because that is what usually
 * happened, and to today. Both are editable — a cheque that arrived last
 * Thursday is dated last Thursday, and dating it today would put it in the
 * wrong month on every report and leave the bank reconciliation short.
 *
 * Resolves truthy when something was recorded, so callers can refresh.
 */
export async function openRecordPayment(invoice, context) {
  const { deposits, settings } = context;

  if (!deposits.length) {
    toast('There is nowhere to record this yet. Add a bank account under '
        + 'Ledger → Chart of accounts first.', 'error');
    return null;
  }

  const outstanding = (Number(invoice.total_cents) || 0) - (Number(invoice.paid_cents) || 0);
  const preferred = (settings && settings.default_deposit_account_id) || deposits[0].id;

  return formModal({
    title: `Record a payment — INV ${invoiceLabel(invoice.number)}`,
    submitLabel: 'Record it',
    intro: outstanding > 0
      ? `${formatMoney(outstanding)} is outstanding. Recording this updates the `
        + 'invoice and posts it to the books.'
      : 'This invoice is already settled. A further payment will show as an '
        + 'overpayment — record a refund as a negative amount.',
    fields: [
      {
        name: 'amount',
        label: 'Amount received',
        type: 'text',
        inputmode: 'decimal',
        required: true,
        value: outstanding > 0 ? formatMoney(outstanding).replace(/^\$/, '') : '',
        hint: 'A negative amount is a refund.',
      },
      { name: 'received_on', label: 'Received on', type: 'date', required: true, value: todayIso(),
        hint: 'The day the money moved, not the day you are typing this.' },
      {
        name: 'deposit_account_id',
        label: 'Into',
        type: 'select',
        value: preferred,
        options: deposits.map((row) => ({ value: row.id, label: accountLabel(row) })),
      },
      {
        name: 'method',
        label: 'How',
        type: 'select',
        value: 'bank_transfer',
        options: PAYMENT_METHODS,
      },
      { name: 'reference', label: 'Reference', type: 'text',
        hint: 'A cheque number or a transfer reference, so it can be found on a statement.' },
      { name: 'notes', label: 'Note', type: 'textarea', rows: 2 },
    ],
    onSubmit: async (values) => {
      const amount = parseMoney(values.amount);
      if (amount === null) throw new Error('That amount is not a number.');
      if (amount === 0) throw new Error('A payment of nothing is not a payment.');

      await recordPayment({
        invoice_id: invoice.id,
        client_id: invoice.client_id,
        received_on: values.received_on,
        amount_cents: amount,
        method: values.method,
        deposit_account_id: values.deposit_account_id,
        reference: values.reference || null,
        notes: values.notes || null,
      });
    },
  });
}

/**
 * The payments already recorded against an invoice, as rows for a panel.
 *
 * Deleting one is offered because a payment entered against the wrong invoice
 * is a mistake with no other way out — there is no "move it", and leaving it
 * would misstate both invoices and the bank. It is a confirm, not a
 * double-confirm: this is a correction to the studio's own record of an event,
 * not a document anybody is holding.
 */
export function paymentRows(payments, { onChange } = {}) {
  if (!payments.length) {
    return [el('p', {
      class: 'empty',
      text: 'Nothing recorded against this invoice yet. Record a payment when '
           + 'one arrives and it is listed here.',
    })];
  }

  return payments.map((payment) => {
    const account = payment.ledger_accounts || {};
    const refund = Number(payment.amount_cents) < 0;

    return el('div', { class: 'doc-row' }, [
      el('div', { class: 'doc-row__main' }, [
        el('p', { class: 'doc-row__name' }, [
          `${refund ? 'Refund ' : ''}${formatMoney(payment.amount_cents)}`,
        ]),
        el('p', { class: 'doc-row__meta' }, [
          el('span', { text: fmtDate(payment.received_on) }),
          el('span', { text: methodLabel(payment.method) }),
          account.code ? el('span', { text: `${account.code} · ${account.name}` }) : null,
          payment.reference ? el('span', { text: payment.reference }) : null,
        ]),
        payment.notes ? el('p', { class: 'doc-row__meta', text: payment.notes }) : null,
      ]),
      onChange
        ? el('button', {
          class: 'btn btn--ghost btn--tiny',
          type: 'button',
          text: 'Remove',
          'aria-label': `Remove the ${formatMoney(payment.amount_cents)} payment `
                      + `received on ${fmtDate(payment.received_on)}`,
          // Removing a payment rewrites the invoice's balance and the books.
          // Pressed twice on a slow connection it ran twice, hence busy().
          onclick: busy(async () => {
            const ok = await confirmModal({
              title: `Remove the ${formatMoney(payment.amount_cents)} payment received on `
                + `${fmtDate(payment.received_on)}?`,
              body: 'The invoice and the books both go back to what they said before it.',
              confirmLabel: 'Remove payment',
              tone: 'danger',
            });
            if (!ok) return;
            try {
              await deletePayment(payment.id);
            } catch (error) {
              toast(errorMessage(error), 'error');
              return;
            }
            toast('Payment removed.', 'ok');
            await onChange();
          }, { label: 'Removing…' }),
        })
        : null,
    ]);
  });
}

export { paymentsForInvoice };
