// ---------------------------------------------------------------------------
// Recording that money arrived.
//
// A payment is a row: an amount, a date, how it came and a reference. The
// invoice's own paid_cents, paid_at and status are maintained from those rows
// by a trigger (supabase/schema.sql), so "mark this paid" is not a thing a
// person does — recording the payment is, and the status follows. An invoice
// that could be marked paid with no payment behind it would be income the
// tax-year report could not explain.
//
// Shared by the invoice editor and anything else that wants to record one, so
// there is exactly one thing that happens when you do.
// ---------------------------------------------------------------------------

import { errorMessage } from './client.js';
import { el, formModal, fmtDate, toast, busy, confirmModal } from './ui.js';
import { formatMoney, parseMoney, centsOf } from './money.js';
import { isoToday } from './doc-common.js';
import { PAYMENT_METHODS, invoiceLabel, methodLabel } from './invoice-catalog.js';
import { deletePayment, paymentsForInvoice, recordPayment } from './invoice-data.js';

/**
 * Record one payment against one invoice.
 *
 * Defaults to the whole outstanding balance, because that is what usually
 * happened, and to today. Both are editable — a check that arrived last
 * Thursday is dated last Thursday, and dating it today would put it in the
 * wrong month on the tax-year report.
 *
 * Resolves with the submitted values when something was recorded and null
 * when the dialog was dismissed, so callers can refresh only when it matters.
 */
export async function openRecordPayment(invoice) {
  const outstanding = centsOf(invoice.total_cents) - centsOf(invoice.paid_cents);

  return formModal({
    title: `Record a payment — ${invoiceLabel(invoice.number)}`,
    submitLabel: 'Record it',
    intro: outstanding > 0
      ? `${formatMoney(outstanding)} is outstanding. Recording this updates the `
        + 'invoice, and marks it paid once the payments cover the total.'
      : 'This invoice is already settled. A further payment shows as an '
        + 'overpayment — record a refund as a negative amount.',
    fields: [
      {
        name: 'received_on',
        label: 'Received on',
        type: 'date',
        required: true,
        value: isoToday(),
        hint: 'The day the money moved, not the day you are typing this.',
      },
      {
        name: 'amount',
        label: 'Amount received',
        type: 'text',
        inputmode: 'decimal',
        required: true,
        value: outstanding > 0 ? formatMoney(outstanding).replace(/^\$/, '') : '',
        hint: 'A negative amount is a refund.',
      },
      {
        name: 'method',
        label: 'How',
        type: 'select',
        value: 'ach',
        options: PAYMENT_METHODS,
      },
      {
        name: 'reference',
        label: 'Reference',
        type: 'text',
        hint: 'A check number or a transfer reference, so it can be found on a statement.',
      },
      { name: 'notes', label: 'Note', type: 'textarea', rows: 2 },
    ],
    onSubmit: async (values) => {
      const amount = parseMoney(values.amount);
      if (amount === null) throw new Error('That amount is not a number.');
      if (amount === 0) throw new Error('A payment of nothing is not a payment.');
      if (!values.received_on) throw new Error('When did it arrive?');

      await recordPayment({
        invoice_id: invoice.id,
        received_on: values.received_on,
        amount_cents: amount,
        method: values.method || 'ach',
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
 * would misstate both invoices. It is a confirm, not a double-confirm: this is
 * a correction to the business's own record of an event, not a document
 * anybody is holding.
 */
export function paymentRows(payments, { onChange } = {}) {
  if (!payments || !payments.length) {
    return [el('p', {
      class: 'empty',
      text: 'Nothing recorded against this invoice yet. Record a payment when '
          + 'one arrives and it is listed here.',
    })];
  }

  return payments.map((payment) => {
    const refund = centsOf(payment.amount_cents) < 0;
    const amount = formatMoney(Math.abs(centsOf(payment.amount_cents)));

    return el('div', { class: 'doc-row' }, [
      el('div', {}, [
        el('p', { class: 'doc-row__name', text: refund ? `Refund ${amount}` : amount }),
        el('p', { class: 'doc-row__meta' }, [
          el('span', { text: fmtDate(payment.received_on) }),
          el('span', { text: methodLabel(payment.method) }),
          payment.reference ? el('span', { text: payment.reference }) : null,
        ]),
        payment.notes ? el('p', { class: 'doc-row__meta', text: payment.notes }) : null,
      ]),
      onChange
        ? el('button', {
          class: 'btn btn--ghost btn--tiny',
          type: 'button',
          text: 'Remove',
          'aria-label': `Remove the ${amount} ${refund ? 'refund' : 'payment'} `
                      + `received on ${fmtDate(payment.received_on)}`,
          // Removing a payment rewrites the invoice's balance and status.
          // Pressed twice on a slow connection it ran twice, hence busy().
          onclick: busy(async () => {
            const ok = await confirmModal({
              title: `Remove the ${amount} ${refund ? 'refund' : 'payment'} received on `
                + `${fmtDate(payment.received_on)}?`,
              body: 'The invoice goes back to what it said before it: the balance '
                  + 'reopens, and a paid invoice becomes sent again.',
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
