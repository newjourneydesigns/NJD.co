// ---------------------------------------------------------------------------
// The bookkeeping: what the account types mean, and how the reports are built
// out of a list of balances.
//
// The same split as sow-fees.js and invoice-catalog.js, for the same reason —
// every screen in the ledger opens a page, so importing one outside a browser
// runs bootstrap(). Everything worth a test lives here instead, and here is
// where the arithmetic that an accountant would check lives too.
//
// The one idea worth reading before the rest: every balance arriving from
// ledger_balances() is already signed the way its account is normally read. An
// asset with more debits than credits is positive; so is income with more
// credits than debits. That flip happens once, in SQL, so that nothing in this
// file has to remember which way round a revenue account goes.
// ---------------------------------------------------------------------------

import { formatMoney } from './sow-fees.js';

/**
 * The account types, in the order a set of books is always presented: what you
 * own, what you owe, what is left over, what came in, what went out.
 *
 * `normal` is the side that makes the balance bigger, which is the single fact
 * that decides everything else. It is stated rather than derived because it is
 * the thing a person reading this file most needs to know.
 */
export const ACCOUNT_TYPES = [
  { value: 'asset',     label: 'Asset',     normal: 'debit',
    hint: 'Something the studio owns or is owed — a bank account, an unpaid invoice, a laptop.' },
  { value: 'liability', label: 'Liability', normal: 'credit',
    hint: 'Something the studio owes — a card balance, tax collected and not yet handed over.' },
  { value: 'equity',    label: 'Equity',    normal: 'credit',
    hint: "The owner's stake: what went in, what came out, and what the business has kept." },
  { value: 'income',    label: 'Income',    normal: 'credit',
    hint: 'What the studio earned.' },
  { value: 'expense',   label: 'Expense',   normal: 'debit',
    hint: 'What it cost to earn it.' },
];

/**
 * The subtypes, grouped under their type, in balance-sheet order.
 *
 * `section` is which block of which report the account prints in, and it is the
 * only reason the subtype exists as a separate column: "current asset" and
 * "fixed asset" are both assets, and a balance sheet that ran them together
 * would be missing the distinction the reader came for.
 */
export const ACCOUNT_SUBTYPES = [
  { value: 'bank',                    type: 'asset',     label: 'Bank account',        section: 'current_assets' },
  { value: 'receivable',              type: 'asset',     label: 'Accounts receivable', section: 'current_assets' },
  { value: 'other_current_asset',     type: 'asset',     label: 'Other current asset', section: 'current_assets' },
  { value: 'fixed_asset',             type: 'asset',     label: 'Fixed asset',         section: 'fixed_assets' },

  { value: 'credit_card',             type: 'liability', label: 'Credit card',             section: 'current_liabilities' },
  { value: 'payable',                 type: 'liability', label: 'Accounts payable',        section: 'current_liabilities' },
  { value: 'other_current_liability', type: 'liability', label: 'Other current liability', section: 'current_liabilities' },
  { value: 'long_term_liability',     type: 'liability', label: 'Long-term liability',     section: 'long_term_liabilities' },

  { value: 'equity',                  type: 'equity',    label: 'Equity',            section: 'equity' },

  { value: 'income',                  type: 'income',    label: 'Income',            section: 'revenue' },
  { value: 'other_income',            type: 'income',    label: 'Other income',      section: 'other_income' },

  { value: 'cost_of_sales',           type: 'expense',   label: 'Cost of sales',     section: 'cost_of_sales' },
  { value: 'expense',                 type: 'expense',   label: 'Operating expense', section: 'operating' },
  { value: 'other_expense',           type: 'expense',   label: 'Other expense',     section: 'other_expense' },
];

export const PAYMENT_METHODS = [
  { value: 'bank_transfer', label: 'Bank transfer' },
  { value: 'card',          label: 'Card' },
  { value: 'check',         label: 'Check' },
  { value: 'cash',          label: 'Cash' },
  { value: 'zelle',         label: 'Zelle' },
  { value: 'other',         label: 'Other' },
];

/** The accounts money can be paid into or out of — a bank, or a card. */
export const CASH_SUBTYPES = ['bank', 'credit_card', 'other_current_asset'];

export function typeLabel(value) {
  const found = ACCOUNT_TYPES.find((row) => row.value === value);
  return found ? found.label : value;
}

export function subtypeLabel(value) {
  const found = ACCOUNT_SUBTYPES.find((row) => row.value === value);
  return found ? found.label : value;
}

export function subtypesFor(type) {
  return ACCOUNT_SUBTYPES.filter((row) => row.type === type);
}

export function methodLabel(value) {
  const found = PAYMENT_METHODS.find((row) => row.value === value);
  return found ? found.label : value;
}

/** Which side a debit-normal account sits on. Used by the entry form to say
 *  "this increases the balance" rather than making somebody remember. */
export function normalSide(type) {
  const found = ACCOUNT_TYPES.find((row) => row.value === type);
  return found ? found.normal : 'debit';
}

/**
 * Money for a report, where a negative is written in parentheses.
 *
 * Not decoration: it is what every accountant, every tax preparer and every
 * other set of books does, and a profit and loss with "-$400.00" on it reads as
 * a typo to the person this report exists to be handed to.
 */
export function formatSigned(cents) {
  const amount = Number(cents) || 0;
  if (amount < 0) return `(${formatMoney(-amount)})`;
  return formatMoney(amount);
}

/** `1000 · Business checking`, which is how an account is named everywhere it
 *  is picked from — the code is what an accountant sorts and searches by. */
export function accountLabel(account) {
  if (!account) return '—';
  return `${account.code} · ${account.name}`;
}

/**
 * The first day of the financial year that `asOf` falls in.
 *
 * A balance sheet has to split what the business made this year from what it
 * made in every year before it, and that split moves with the fiscal year. Both
 * arguments are passed in rather than read from the clock or the settings, so
 * the same inputs always give the same answer.
 */
export function fiscalYearStart(asOf, startMonth = 1) {
  const iso = String(asOf).slice(0, 10);
  const year = Number(iso.slice(0, 4));
  const month = Number(iso.slice(5, 7));
  const start = Number(startMonth) || 1;
  const useYear = month >= start ? year : year - 1;
  return `${useYear}-${String(start).padStart(2, '0')}-01`;
}

/** The day before a date, so "everything up to the start of this year" can be
 *  asked for as a closed range. */
export function dayBefore(iso) {
  const date = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function sum(rows, pick) {
  return rows.reduce((total, row) => total + (Number(pick(row)) || 0), 0);
}

function bySection(rows, section) {
  const wanted = ACCOUNT_SUBTYPES
    .filter((row) => row.section === section)
    .map((row) => row.value);
  return rows.filter((row) => wanted.includes(row.subtype));
}

/**
 * Only the accounts worth printing.
 *
 * An account with no movement and no balance is noise on a report — the chart
 * seeds forty of them and a new studio uses eight. An archived account with a
 * balance still prints, because money that is somewhere has to be shown
 * wherever it is.
 */
function used(rows) {
  return rows.filter((row) => (
    Number(row.balance) !== 0 || Number(row.debits) !== 0 || Number(row.credits) !== 0
  ));
}

/**
 * The trial balance: every account, both columns, and the proof that they
 * match.
 *
 * This is the report that says whether the books are internally consistent, and
 * `balanced` should be true forever — the database refuses an entry that would
 * make it false. It is shown anyway, because a claim that is never checked is a
 * claim nobody should rely on.
 */
export function trialBalance(balances) {
  const rows = used(balances || []);
  const debits = sum(rows, (row) => row.debits);
  const credits = sum(rows, (row) => row.credits);

  return {
    rows,
    debits,
    credits,
    difference: debits - credits,
    balanced: debits === credits,
  };
}

/**
 * Profit and loss for a window.
 *
 * The shape is the conventional one, and each subtotal answers a different
 * question: gross profit is what the work itself earns, operating profit is
 * what the business earns after the cost of being open, and net profit is what
 * is actually left. Running them together would collapse three answers into one.
 *
 * `cashRevenue`, when given, replaces the accrual revenue lines with what
 * ledger_cash_income() worked out — the same report, read the other way. Costs
 * are not switched with it, and that is correct rather than lazy: an expense in
 * this system is recorded when it is paid, so the two bases already agree on
 * them. The screen says so rather than leaving it to be assumed.
 */
export function profitAndLoss(balances, cashRevenue = null) {
  const rows = balances || [];

  let revenue = used(bySection(rows, 'revenue'));
  if (cashRevenue) {
    const byId = new Map(cashRevenue.map((row) => [row.account_id, Number(row.amount) || 0]));
    revenue = rows
      .filter((row) => byId.has(row.account_id))
      .map((row) => ({ ...row, balance: byId.get(row.account_id) }));
  }

  const costOfSales = used(bySection(rows, 'cost_of_sales'));
  const operating = used(bySection(rows, 'operating'));
  const otherIncome = used(bySection(rows, 'other_income'));
  const otherExpense = used(bySection(rows, 'other_expense'));

  const revenueTotal = sum(revenue, (row) => row.balance);
  const costTotal = sum(costOfSales, (row) => row.balance);
  const grossProfit = revenueTotal - costTotal;
  const operatingTotal = sum(operating, (row) => row.balance);
  const operatingProfit = grossProfit - operatingTotal;
  const otherIncomeTotal = sum(otherIncome, (row) => row.balance);
  const otherExpenseTotal = sum(otherExpense, (row) => row.balance);

  return {
    revenue,
    revenueTotal,
    costOfSales,
    costTotal,
    grossProfit,
    // The number a studio actually steers by. Guarded against a zero-revenue
    // period, where the honest answer is "no margin to speak of" rather than a
    // division by zero rendered as NaN%.
    grossMargin: revenueTotal ? grossProfit / revenueTotal : null,
    operating,
    operatingTotal,
    operatingProfit,
    otherIncome,
    otherIncomeTotal,
    otherExpense,
    otherExpenseTotal,
    netProfit: operatingProfit + otherIncomeTotal - otherExpenseTotal,
  };
}

/**
 * The balance sheet, as of a date.
 *
 * `toDate` is every balance since the books opened; `thisYear` is the same
 * accounts over the current financial year only. Both are needed because equity
 * has two pieces that no account holds directly:
 *
 *   net profit        what the business has made since the year began
 *   retained earnings what it made in every year before that and kept
 *
 * Most systems make you post a closing entry each year to move one into the
 * other. This works them out instead, so there is no annual ritual to forget
 * and no year where the balance sheet is wrong until somebody remembers it.
 *
 * `balanced` is the check that matters: assets must equal liabilities plus
 * equity, or something is wrong with the books rather than with the report.
 */
export function balanceSheet(toDate, thisYear) {
  const rows = toDate || [];

  const currentAssets = used(bySection(rows, 'current_assets'));
  const fixedAssets = used(bySection(rows, 'fixed_assets'));
  const currentLiabilities = used(bySection(rows, 'current_liabilities'));
  const longTermLiabilities = used(bySection(rows, 'long_term_liabilities'));
  const equity = used(bySection(rows, 'equity'));

  const profitOf = (source) => {
    const set = source || [];
    const income = sum(set.filter((row) => row.type === 'income'), (row) => row.balance);
    const expense = sum(set.filter((row) => row.type === 'expense'), (row) => row.balance);
    return income - expense;
  };

  const netProfit = profitOf(thisYear);
  const retained = profitOf(rows) - netProfit;

  const assetsTotal = sum(currentAssets, (row) => row.balance)
    + sum(fixedAssets, (row) => row.balance);
  const liabilitiesTotal = sum(currentLiabilities, (row) => row.balance)
    + sum(longTermLiabilities, (row) => row.balance);
  const equityTotal = sum(equity, (row) => row.balance) + retained + netProfit;

  return {
    currentAssets,
    fixedAssets,
    assetsTotal,
    currentLiabilities,
    longTermLiabilities,
    liabilitiesTotal,
    equity,
    retained,
    netProfit,
    equityTotal,
    difference: assetsTotal - (liabilitiesTotal + equityTotal),
    balanced: assetsTotal === liabilitiesTotal + equityTotal,
  };
}

export const AGING_BUCKETS = [
  { key: 'current', label: 'Not yet due' },
  { key: 'd30',     label: '1–30 days' },
  { key: 'd60',     label: '31–60 days' },
  { key: 'd90',     label: '61–90 days' },
  { key: 'older',   label: 'Over 90 days' },
];

/**
 * Who owes what, and how long they have owed it.
 *
 * Built from the invoices rather than from the ledger, because the ledger knows
 * the total owed and not which document it belongs to — and "chase this one" is
 * a question about a document. The two are cross-checked on the report itself:
 * this total and the Accounts receivable balance are the same fact counted two
 * ways, and if they ever disagree that is worth knowing immediately.
 *
 * Drafts, voids and paid invoices are all excluded. An invoice with no due date
 * counts as due on the day it was issued, which is the least generous honest
 * reading and stops a missing field hiding a debt in the "not yet due" column.
 */
export function agingReport(invoices, today) {
  const now = String(today).slice(0, 10);
  const rows = [];

  (invoices || []).forEach((invoice) => {
    if (['draft', 'void', 'paid'].includes(invoice.status)) return;
    const outstanding = (Number(invoice.total_cents) || 0) - (Number(invoice.paid_cents) || 0);
    if (outstanding <= 0) return;

    const due = String(invoice.due_on || invoice.issued_on || now).slice(0, 10);
    const days = Math.floor(
      (Date.parse(`${now}T00:00:00Z`) - Date.parse(`${due}T00:00:00Z`)) / 86400000,
    );

    let bucket = 'current';
    if (days > 90) bucket = 'older';
    else if (days > 60) bucket = 'd90';
    else if (days > 30) bucket = 'd60';
    else if (days > 0) bucket = 'd30';

    rows.push({ invoice, outstanding, days: days > 0 ? days : 0, bucket });
  });

  const byClient = new Map();
  rows.forEach((row) => {
    const client = row.invoice.clients || {};
    const key = row.invoice.client_id || 'unknown';
    if (!byClient.has(key)) {
      byClient.set(key, {
        clientId: key,
        name: client.name || client.legal_name || 'Unknown client',
        total: 0,
        rows: [],
        ...Object.fromEntries(AGING_BUCKETS.map((b) => [b.key, 0])),
      });
    }
    const entry = byClient.get(key);
    entry.total += row.outstanding;
    entry[row.bucket] += row.outstanding;
    entry.rows.push(row);
  });

  const clients = Array.from(byClient.values()).sort((a, b) => b.total - a.total);
  const totals = Object.fromEntries(AGING_BUCKETS.map((b) => [
    b.key, sum(clients, (row) => row[b.key]),
  ]));

  return {
    clients,
    totals,
    total: sum(clients, (row) => row.total),
    overdue: sum(clients, (row) => row.total - row.current),
  };
}

/**
 * What each client has been worth, and what each one cost.
 *
 * Reads the ledger's own client column rather than the invoices, which is what
 * makes it able to answer the second half: an invoice knows what was charged,
 * and only a ledger line knows that the stock photography for that job came to
 * $240. The margin is the number worth having — a client who pays well and
 * consumes three subcontractors is not the client they look like.
 */
export function byClient(lines) {
  const map = new Map();

  (lines || []).forEach((line) => {
    const account = line.ledger_accounts || {};
    if (!['income', 'expense'].includes(account.type)) return;
    const key = line.client_id || 'none';
    if (!map.has(key)) {
      map.set(key, {
        clientId: line.client_id || null,
        name: (line.clients && line.clients.name) || 'Not assigned to a client',
        revenue: 0,
        cost: 0,
      });
    }
    const entry = map.get(key);
    const net = (Number(line.credit_cents) || 0) - (Number(line.debit_cents) || 0);
    if (account.type === 'income') entry.revenue += net;
    else entry.cost -= net;
  });

  return Array.from(map.values())
    .map((row) => ({
      ...row,
      profit: row.revenue - row.cost,
      margin: row.revenue ? (row.revenue - row.cost) / row.revenue : null,
    }))
    .sort((a, b) => b.revenue - a.revenue);
}

/**
 * The 1099-NEC list.
 *
 * Anyone unincorporated paid $600 or more for services in a calendar year needs
 * a form, and the deadline is January 31st — which is a terrible time to start
 * working out who they were. `threshold` is a parameter because the IRS has
 * moved it before and will again.
 *
 * `missingTaxId` is the column that actually earns this report its place. A
 * contractor who needs a 1099 and whose W-9 was never collected is a problem
 * with a cheap fix in June and an expensive one in January.
 */
export function vendorTotals(expenses, vendors, year, threshold = 60000) {
  const totals = new Map();

  (expenses || []).forEach((row) => {
    if (year && String(row.spent_on).slice(0, 4) !== String(year)) return;
    if (!row.vendor_id) return;
    totals.set(row.vendor_id, (totals.get(row.vendor_id) || 0) + (Number(row.amount_cents) || 0));
  });

  return (vendors || [])
    .map((vendor) => {
      const paid = totals.get(vendor.id) || 0;
      return {
        vendor,
        paid,
        reportable: Boolean(vendor.files_1099) && paid >= threshold,
        missingTaxId: Boolean(vendor.files_1099) && paid >= threshold && !vendor.tax_id_on_file,
      };
    })
    .filter((row) => row.paid !== 0 || row.vendor.files_1099)
    .sort((a, b) => b.paid - a.paid);
}

/**
 * What is missing from an expense before it would survive an examination.
 *
 * The IRS wants five things for a meal, a trip, a gift or a mile driven
 * (Publication 463): how much, when, where, the business purpose, and the
 * business relationship of anybody else there. The first two are on every
 * expense and a receipt photograph proves them. The last three are the ones
 * that get forgotten and the ones a deduction is disallowed for — a shoebox of
 * receipts with no story attached is the classic failed audit.
 *
 * `attendees` is only asked for where somebody else was present, which is meals
 * and gifts. Nobody has to name the people on a hotel bill.
 *
 * Returns the list of what is missing, so a screen can name it rather than
 * showing a red dot.
 */
export function substantiationGaps(expense, account) {
  const needed = account ? account.needs_substantiation : false;
  if (!needed) return [];

  const gaps = [];
  const code = (account && account.code) || '';

  if (!String(expense.place || '').trim()) gaps.push('where it was');
  if (!String(expense.business_purpose || '').trim()) gaps.push('the business purpose');

  // Meals and gifts are the two where somebody else is the point of the spend.
  if (['6070', '6075'].includes(code) && !String(expense.attendees || '').trim()) {
    gaps.push('who was there');
  }

  // A mileage claim without a distance is not a claim at all.
  if (code === '6090' && !(Number(expense.miles) > 0)) gaps.push('how many miles');

  return gaps;
}

/** Is this expense ready to hand to a preparer? */
export function isSubstantiated(expense, account) {
  return substantiationGaps(expense, account).length === 0;
}

/**
 * What the standard mileage rate makes a trip worth.
 *
 * The rate is passed in rather than held here because the IRS republishes it
 * every December, and a constant compiled into a bundle is a constant that is
 * quietly wrong every January.
 */
export function mileageAmount(miles, rateCents) {
  const distance = Number(miles);
  const rate = Number(rateCents);
  if (!Number.isFinite(distance) || !Number.isFinite(rate)) return 0;
  return Math.round(distance * rate);
}

/**
 * The two accounts a mileage claim moves between, named by their chart codes —
 * the same way substantiationGaps() recognises them.
 *
 * The debit is obvious. The credit deserves its sentence: the standard mileage
 * rate deducts the cost of a car the business never paid for, so no bank or
 * card balance moved. The owner absorbed it personally, and personally-borne
 * costs enter the books as owner's contributions.
 */
export const MILEAGE_ACCOUNT_CODE = '6090';

/**
 * The member whose capital account a personally-borne cost belongs to.
 *
 * There is no single "owner's funds" account any more, and that is the point:
 * this studio has four members, and a pooled capital account cannot say what
 * any one of them put in. Returns the owner_members row, or null when the
 * person is not a member — which callers must treat as a refusal rather than
 * a reason to guess at somebody's account.
 */
export function memberFor(members, profileId) {
  if (!profileId) return null;
  return (members || []).find((row) => row.profile_id === profileId) || null;
}

/** The name a tax document should carry. The portal calls them Trip and Vic;
 *  a K-1 does not. Falls back to the display name where no legal name is
 *  recorded, so this is an improvement where filled in and never a blank. */
export function memberName(member) {
  const legal = String((member && member.legal_name) || '').trim();
  if (legal) return legal;
  const profile = (member && member.profiles) || null;
  const display = String((profile && profile.full_name) || '').trim();
  if (display) return display;
  const email = String((profile && profile.email) || '').trim();
  return email ? email.split('@')[0] : 'Unnamed member';
}

/**
 * Name a person from an embedded profile row.
 *
 * Used wherever the books have to say who did something — who entered an
 * expense, who drove a trip. "Not recorded" rather than a blank, because an
 * empty cell in a column of names reads as an oversight rather than as a fact
 * about a row that predates the column.
 */
export function personName(profile, fallback = 'Not recorded') {
  const full = String((profile && profile.full_name) || '').trim();
  if (full) return full;
  const email = String((profile && profile.email) || '').trim();
  return email ? email.split('@')[0] : fallback;
}

/** Ownership as a percentage, from the basis points the row holds. */
export function ownershipPct(member) {
  return (Number(member && member.ownership_bp) || 0) / 100;
}

/**
 * A mileage rate in dollars, with the half-cent shown when there is one:
 * "$0.76", "$0.725". Two decimals would render 72.5¢ as $0.73 — a rounding the
 * IRS did not publish.
 */
export function mileageRateLabel(rateCents) {
  const dollars = (Number(rateCents) || 0) / 100;
  return `$${dollars.toFixed((Number(rateCents) || 0) % 1 ? 3 : 2)}`;
}

/** Days in a month, asked the calendar rather than remembered. */
function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function isoDay(year, month, day) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Where a recurring charge stands against the calendar.
 *
 * Returns { due, dueOn, behind }. `dueOn` is the next month it should be
 * recorded for — the month after the last recorded one, or the current month
 * for a fresh template — with the billing day clamped to the month's length,
 * so "the 31st" bills February honestly. `behind` counts how many months are
 * waiting (1 is the normal case; more means bookkeeping lapsed and each
 * Record will walk forward a month at a time, so a lapse backfills instead
 * of leaving holes).
 *
 * A paused template is never due. A fresh template starts at the current
 * month rather than reaching into the past: the months before it existed
 * here were recorded by hand or not at all, and inventing them is not this
 * function's call.
 */
export function recurringStatus(template, todayIso) {
  const none = { due: false, dueOn: null, behind: 0 };
  if (!template || !template.active) return none;

  const today = String(todayIso).slice(0, 10);
  const [ty, tm] = today.split('-').map(Number);

  let ny = ty;
  let nm = tm;
  const last = template.last_recorded_on ? String(template.last_recorded_on).slice(0, 7) : null;
  if (last) {
    const [ly, lm] = last.split('-').map(Number);
    ny = lm === 12 ? ly + 1 : ly;
    nm = lm === 12 ? 1 : lm + 1;
    // Recorded through this month (or beyond) already: nothing is waiting.
    if (`${ny}-${String(nm).padStart(2, '0')}` > today.slice(0, 7)) return none;
  }

  const day = Math.min(Number(template.day_of_month) || 1, daysInMonth(ny, nm));
  const dueOn = isoDay(ny, nm, day);
  if (dueOn > today) return { due: false, dueOn, behind: 0 };

  return { due: true, dueOn, behind: (ty - ny) * 12 + (tm - nm) + 1 };
}

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * The months of the financial year so far, each as a closed date range —
 * what a by-month profit and loss asks the ledger twelve times.
 *
 * Labels carry a year only when the fiscal year crosses one, so a January
 * start reads "Jan Feb Mar…" and a July start reads "Jul 25 … Jan 26".
 */
export function monthSpans(asOf, startMonth = 1) {
  const start = fiscalYearStart(asOf, startMonth);
  const endKey = String(asOf).slice(0, 7);
  const crossesYear = (Number(startMonth) || 1) !== 1;

  const spans = [];
  let year = Number(start.slice(0, 4));
  let month = Number(start.slice(5, 7));

  while (`${year}-${String(month).padStart(2, '0')}` <= endKey && spans.length < 12) {
    spans.push({
      key: `${year}-${String(month).padStart(2, '0')}`,
      from: isoDay(year, month, 1),
      to: isoDay(year, month, daysInMonth(year, month)),
      label: MONTH_SHORT[month - 1] + (crossesYear ? ` ${String(year).slice(2)}` : ''),
    });
    month += 1;
    if (month === 13) { month = 1; year += 1; }
  }
  return spans;
}

/**
 * The by-month profit and loss: the same report, twelve columns wide.
 *
 * This is the view an accountant reads first and a single-period P&L cannot
 * give: one bad month next to eleven good ones, a subscription that doubled
 * in March, the seasonality of a studio's revenue. `byMonth` maps a span key
 * to that month's balances, exactly as ledger_balances() returned them.
 *
 * Every account that moved in any month gets a row, so the columns line up
 * across the year — an account absent from June prints a zero there rather
 * than shifting June's figures up a line.
 */
export function monthlyProfitAndLoss(spans, byMonth) {
  const months = spans || [];
  const reports = months.map((span) => profitAndLoss((byMonth && byMonth[span.key]) || []));

  const groups = [
    { key: 'revenue', title: 'Revenue', pick: (pl) => pl.revenue, total: (pl) => pl.revenueTotal },
    { key: 'costOfSales', title: 'Cost of sales', pick: (pl) => pl.costOfSales, total: (pl) => pl.costTotal },
    { key: 'operating', title: 'Operating expenses', pick: (pl) => pl.operating, total: (pl) => pl.operatingTotal },
    { key: 'otherIncome', title: 'Other income', pick: (pl) => pl.otherIncome, total: (pl) => pl.otherIncomeTotal },
    { key: 'otherExpense', title: 'Other costs', pick: (pl) => pl.otherExpense, total: (pl) => pl.otherExpenseTotal },
  ].map((group) => {
    const seen = new Map();
    reports.forEach((pl, index) => {
      group.pick(pl).forEach((row) => {
        if (!seen.has(row.account_id)) {
          seen.set(row.account_id, {
            account_id: row.account_id,
            code: row.code,
            name: row.name,
            values: months.map(() => 0),
          });
        }
        seen.get(row.account_id).values[index] = Number(row.balance) || 0;
      });
    });

    const rows = Array.from(seen.values())
      .sort((a, b) => String(a.code).localeCompare(String(b.code)))
      .map((row) => ({ ...row, total: row.values.reduce((t, v) => t + v, 0) }));

    const totals = months.map((_, index) => group.total(reports[index]));

    return {
      key: group.key,
      title: group.title,
      rows,
      totals,
      total: totals.reduce((t, v) => t + v, 0),
    };
  }).filter((group) => group.rows.length);

  const figures = [
    { key: 'grossProfit', label: 'Gross profit', of: (pl) => pl.grossProfit },
    { key: 'operatingProfit', label: 'Operating profit', of: (pl) => pl.operatingProfit },
    { key: 'netProfit', label: 'Net profit', of: (pl) => pl.netProfit },
  ].map((figure) => {
    const values = reports.map(figure.of);
    return {
      key: figure.key,
      label: figure.label,
      values,
      total: values.reduce((t, v) => t + v, 0),
    };
  });

  return { months, groups, figures };
}

/**
 * Each member's capital account, which is the schedule a K-1 is built from.
 *
 * For every member: what they put in, what they took out, their share of the
 * period's profit, and what that leaves them holding. Contributions and draws
 * come from their own two accounts — that is the whole reason the accounts are
 * per member — and the profit share is the allocation their percentage buys.
 *
 * Two things this deliberately does NOT do. It does not post the profit
 * allocation to anybody's account: allocating profit to member capital is a
 * year-end entry a preparer makes, and a report that quietly did it would put
 * a figure in the books that nobody chose. And it does not rescue an ownership
 * table that fails to total 100% — it reports the total and says so, because a
 * split that does not tie is a K-1 that does not tie, and hiding it in a
 * rounding would be the worst possible kindness.
 *
 * `balances` is what ledger_balances() returned, already signed the way each
 * account is normally read: a contributions account credit-normal and positive,
 * a draws account credit-normal and therefore negative when money went out.
 * Draws are flipped here so the column reads as a positive "taken out".
 */
export function ownerCapital(members, balances, netProfit = 0) {
  const byAccount = new Map((balances || []).map((row) => [row.account_id, row]));
  const balanceOf = (id) => Number((byAccount.get(id) || {}).balance) || 0;

  const rows = (members || [])
    .slice()
    .sort((a, b) => (a.position - b.position) || (b.ownership_bp - a.ownership_bp))
    .map((member) => {
      const contributed = balanceOf(member.contributions_account_id);
      // Credit-normal account, debited when money goes out, so the balance
      // arrives negative. The report wants "took out: $3,000", not "($3,000)".
      const drawn = -balanceOf(member.draws_account_id);
      const share = Math.round((Number(netProfit) || 0) * (Number(member.ownership_bp) || 0) / 10000);

      return {
        member,
        name: memberName(member),
        ownershipBp: Number(member.ownership_bp) || 0,
        pct: ownershipPct(member),
        contributed,
        drawn,
        share,
        capital: contributed - drawn + share,
      };
    });

  const totalBp = rows.reduce((t, row) => t + row.ownershipBp, 0);
  const allocated = rows.reduce((t, row) => t + row.share, 0);

  return {
    rows,
    totalBp,
    // The allocation is whole cents per member, so it can miss the profit by a
    // cent or two. Named rather than smoothed away: a preparer decides who
    // absorbs a rounding penny, not this function.
    rounding: (Number(netProfit) || 0) - allocated,
    balanced: totalBp === 10000,
    contributed: rows.reduce((t, row) => t + row.contributed, 0),
    drawn: rows.reduce((t, row) => t + row.drawn, 0),
    capital: rows.reduce((t, row) => t + row.capital, 0),
  };
}

/**
 * Everything wrong with a journal entry, worst first.
 *
 * Same contract as the SOW's and the invoice's validate(): `blocking` stops the
 * save, anything else is a warning the operator is trusted to overrule. The
 * balance check is blocking because the database will refuse it anyway, and a
 * message written here can say which way it is out and by how much.
 */
export function validateEntry({ entry, lines = [] } = {}) {
  const problems = [];
  const add = (blocking, field, message) => problems.push({ blocking, field, message });

  if (!entry || !entry.entry_date) {
    add(true, 'entry_date', 'An entry needs a date. It is what every report sorts and filters on.');
  }

  const real = lines.filter((line) => (
    line.account_id && ((Number(line.debit_cents) || 0) || (Number(line.credit_cents) || 0))
  ));

  if (real.length < 2) {
    add(true, 'lines', 'An entry needs at least two lines — one side of the money and the other.');
  }

  if (lines.some((line) => !line.account_id
    && ((Number(line.debit_cents) || 0) || (Number(line.credit_cents) || 0)))) {
    add(true, 'lines', 'A line with an amount on it needs an account. Pick one, or clear the amount.');
  }

  const debits = sum(real, (line) => line.debit_cents);
  const credits = sum(real, (line) => line.credit_cents);

  if (real.length >= 2 && debits !== credits) {
    add(true, 'lines', `This is out by ${formatMoney(Math.abs(debits - credits))}. `
      + `Debits come to ${formatMoney(debits)} and credits to ${formatMoney(credits)}, `
      + 'and every entry has to come to zero.');
  }

  if (real.length >= 2 && debits === 0 && credits === 0) {
    add(true, 'lines', 'Every line is zero, so this entry says nothing.');
  }

  if (lines.some((line) => (Number(line.debit_cents) || 0) && (Number(line.credit_cents) || 0))) {
    add(true, 'lines', 'A line is either a debit or a credit, never both.');
  }

  if (!entry || !entry.memo) {
    add(false, 'memo', 'No memo. In a year this is the only thing that will say why '
      + 'this entry exists.');
  }

  return problems.sort((a, b) => Number(b.blocking) - Number(a.blocking));
}

export function blockers(problems) {
  return (problems || []).filter((problem) => problem.blocking);
}

/** Running totals for the entry form, so the operator sees the difference close
 *  as they type rather than finding out when they save. */
export function entryTotals(lines = []) {
  const debits = sum(lines, (line) => line.debit_cents);
  const credits = sum(lines, (line) => line.credit_cents);
  return { debits, credits, difference: debits - credits, balanced: debits === credits };
}

/**
 * The reconciliation arithmetic.
 *
 * `cleared` is what the ledger says has hit the bank; the statement says what
 * the bank thinks. Difference zero is the whole point of the exercise — it is
 * the moment the books are known to be complete rather than merely consistent.
 */
export function reconcileTotals(lines, { openingCents = 0, closingCents = 0 } = {}) {
  const ticked = (lines || []).filter((line) => line.cleared_on);
  const movement = ticked.reduce((total, line) => (
    total + ((Number(line.debit_cents) || 0) - (Number(line.credit_cents) || 0))
  ), 0);

  const cleared = (Number(openingCents) || 0) + movement;
  const difference = (Number(closingCents) || 0) - cleared;

  return {
    ticked: ticked.length,
    movement,
    cleared,
    difference,
    balanced: difference === 0,
  };
}

/** The list filter shared by the journal and the account register. */
export function filterEntries(rows, { search = '', source = '', accountId = '' } = {}) {
  const needle = String(search).trim().toLowerCase();

  return (rows || []).filter((row) => {
    if (source && row.source !== source) return false;
    if (accountId && !(row.ledger_lines || []).some((line) => line.account_id === accountId)) {
      return false;
    }
    if (!needle) return true;

    const haystack = [
      row.memo,
      row.reference,
      ...(row.ledger_lines || []).flatMap((line) => [
        line.description,
        line.ledger_accounts && line.ledger_accounts.name,
        line.ledger_accounts && line.ledger_accounts.code,
      ]),
    ].filter(Boolean).join(' ').toLowerCase();

    return haystack.includes(needle);
  });
}

// What the form can work out for itself
// ---------------------------------------------------------------------------
//
// An expense has fifteen things worth knowing about it and a person recording
// one at a lunch counter has patience for four. Nothing below drops a field —
// every one of them is still collected and still exported. They are the
// answers the ledger already knows, so that the person only types the ones it
// cannot.

/**
 * The saved vendor a typed name means, or null for a name nobody has used yet.
 *
 * Case- and space-insensitive because "adobe" typed on a phone and "Adobe" in
 * the vendor table are the same supplier, and a second vendor row for the
 * casing is how "what did we spend at Adobe this year" stops having an answer.
 * The unique index on lower(name) in schema.sql takes the same view.
 */
export function matchVendor(name, vendors) {
  const needle = String(name || '').trim().toLowerCase();
  if (!needle) return null;
  return (vendors || []).find(
    (vendor) => String(vendor.name || '').trim().toLowerCase() === needle,
  ) || null;
}

/**
 * How a payment made from this account was almost certainly made.
 *
 * "What paid for it" and "How" are two questions with one answer nearly every
 * time: money leaving a credit card left it on a card. Derived rather than
 * asked, and still editable — the check written off the checking account is
 * the exception that has to stay possible.
 *
 * A capital account means the member paid it personally, out of whatever was
 * in their pocket, and the ledger has no way to know which. Left alone.
 */
export function defaultMethodFor(account) {
  if (!account) return null;
  if (account.subtype === 'credit_card') return 'card';
  if (account.subtype === 'bank') return 'bank_transfer';
  return null;
}

/**
 * The distinct values a column has recently held, newest first, for a
 * datalist.
 *
 * This is what stops "Client meeting" and "Client Meeting" becoming two
 * different reasons for the same trip. Matched case-insensitively but offered
 * in the casing it was last written in, so the list reads like the person's
 * own words rather than a normalised version of them.
 */
export function recentValues(rows, field, { limit = 12 } = {}) {
  const seen = new Set();
  const out = [];

  for (const row of rows || []) {
    const value = String((row && row[field]) || '').trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= limit) break;
  }

  return out;
}
