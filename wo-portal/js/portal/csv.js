// ---------------------------------------------------------------------------
// CSV export
//
// Small on purpose: a spreadsheet of rows is a text file, and every dependency
// that could produce one would be larger than this file. Two exports — toCsv
// builds the text and touches no DOM (so it can be tested anywhere), and
// downloadCsv hands it to the browser.
//
// Two things here are not decoration:
//
// 1. Quoting. RFC 4180 says a field containing a comma, a quote or a newline is
//    wrapped in quotes with its own quotes doubled. Enquiry messages contain all
//    three, so a naive join would shift every column after the first paragraph
//    break and nobody would notice until the import looked "mostly fine".
//
// 2. Formula injection. These rows are typed by strangers on the public web.
//    Excel, Numbers and Sheets all treat a cell starting with = + - @ (or a
//    control character that leads to one) as a formula and run it on open, which
//    turns a lead's name into code executing on the studio's machine. Prefixing
//    with an apostrophe is the documented mitigation: the spreadsheet shows the
//    text and runs nothing. The cost is a visible leading quote in the rare cell
//    that starts that way, which is the right trade against DDE.
// ---------------------------------------------------------------------------

const NEEDS_QUOTES = /[",\r\n]/;

const FORMULA_START = /^[=+\-@\t\r]/;

function cell(value) {
  if (value === null || value === undefined) return '';

  let text = String(value);
  if (FORMULA_START.test(text)) text = `'${text}`;
  if (NEEDS_QUOTES.test(text)) text = `"${text.replace(/"/g, '""')}"`;

  return text;
}

/**
 * headers: ['Received', 'Name', …]
 * rows:    [['2026-08-02 08:06', 'Dana', …], …]
 *
 * CRLF line endings, because that is what RFC 4180 specifies and what the
 * fussier spreadsheet importers still expect. Everything reading CSV today
 * copes with either.
 */
export function toCsv(headers, rows) {
  return [headers, ...rows]
    .map((row) => row.map(cell).join(','))
    .join('\r\n');
}

/**
 * Saves the rows as a file. The leading BOM is what stops Excel on Windows from
 * reading UTF-8 as its local codepage and turning an é in somebody's name into
 * mojibake; every other reader skips it.
 *
 * The object URL is revoked on the next tick rather than immediately — Safari
 * has to still be able to resolve it when the click is handled.
 */
export function downloadCsv(filename, headers, rows) {
  const blob = new Blob([`\uFEFF${toCsv(headers, rows)}`], {
    type: 'text/csv;charset=utf-8',
  });

  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;

  // Firefox only follows a click on a link that is in the document.
  document.body.append(link);
  link.click();
  link.remove();

  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
