'use strict';

/**
 * Reads Intuit's ProfitAndLoss report JSON into the few figures a host's
 * "sales this period" tile needs. Pure and read-only: report in, numbers out.
 *
 * WHY THE P&L, not summed invoices (Paul's brief-bar rule, 2026-09-06, kept
 * here): invoices miss Sales Receipts and Credit Memos, so a summed-invoice
 * "sales" figure overstates on a day a credit memo lands and understates
 * cash sales. The P&L's Total Income is what the books call income for the
 * window, on the basis asked for.
 *
 * THE SHAPE (Intuit's ProfitAndLoss reference, and a live production report
 * read 2026-09-06 through the old command center): Rows.Row holds Sections,
 * each with a `group` ("Income", "COGS", "Expenses", "NetIncome", ...) and a
 * Summary whose ColData[0] is the label ("Total Income") and ColData[1] the
 * amount for the report's single Total column. A Section may nest further
 * Sections (income accounts under Income). The GrandTotal-style rows carry
 * `group: "NetIncome"`.
 *
 * A figure is found by the Section's `group`, then by the Summary label -
 * never by position among the rows. A report with no Income section at all
 * is refused (ProfitAndLossShapeError) rather than read as $0: a tile that
 * shows zero sales because a column moved is a wrong answer that looks right.
 */

class ProfitAndLossShapeError extends Error {
  constructor(what, detail) {
    super('ProfitAndLoss report has no ' + what + (detail ? ' (' + detail + ')' : '') +
      '. Refusing to read it as zero.');
    this.name = 'ProfitAndLossShapeError';
    this.what = what;
  }
}

/** "1,234.50" or "-12.00" or "" -> a number, or null when it is not one. */
function amount(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/,/g, '').trim();
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

/** Every Section row in the report, depth first, with its group and summary. */
function sections(rows, out = []) {
  for (const r of (rows && rows.Row) || []) {
    if (!r || typeof r !== 'object') continue;
    if (r.type === 'Section' || r.Rows || r.Summary) {
      out.push(r);
      if (r.Rows) sections(r.Rows, out);
    }
  }
  return out;
}

/** The label and the first amount cell of a section's Summary. */
function summaryOf(section) {
  const cells = (section.Summary && section.Summary.ColData) || [];
  const label = cells[0] ? String(cells[0].value || '').trim() : '';
  // The amount is the LAST numeric cell: a report summarised by month puts
  // the Total column last; a plain report has one amount cell.
  let value = null;
  for (let i = cells.length - 1; i >= 1; i -= 1) {
    const n = amount(cells[i] && cells[i].value);
    if (n !== null) { value = n; break; }
  }
  return { label, value };
}

/**
 * Find a section by group, else by its summary label. Returns the amount, or
 * null when the section is absent (an empty period has no Expenses section at
 * all, and that is a legitimate zero the CALLER decides on, not this file).
 */
function figure(all, group, labelRe) {
  const byGroup = all.find((s) => s.group === group);
  if (byGroup) return summaryOf(byGroup).value;
  const byLabel = all.find((s) => labelRe.test(summaryOf(s).label));
  return byLabel ? summaryOf(byLabel).value : null;
}

/**
 * @param {object} report  the ProfitAndLoss report JSON
 * @returns {{ header: { start, end, basis, currency }, totalIncome, totalExpenses, netIncome }}
 *   `totalIncome` is a number (a report with an Income section whose summary
 *   is blank reads as 0 - that is what an empty period looks like);
 *   `totalExpenses` and `netIncome` are numbers or null when absent.
 * @throws ProfitAndLossShapeError when the report has no rows or no Income section
 */
function parseProfitAndLoss(report) {
  if (!report || typeof report !== 'object') throw new ProfitAndLossShapeError('body');
  const h = report.Header || {};
  const all = sections(report.Rows);
  if (all.length === 0) throw new ProfitAndLossShapeError('rows', 'Rows.Row is empty or missing');
  const income = all.find((s) => s.group === 'Income') || all.find((s) => /^total income$/i.test(summaryOf(s).label));
  if (!income) {
    throw new ProfitAndLossShapeError('Income section', 'sections: ' +
      all.map((s) => s.group || summaryOf(s).label || '?').join(', '));
  }
  const totalIncome = summaryOf(income).value;
  return {
    header: {
      start: h.StartPeriod || null,
      end: h.EndPeriod || null,
      basis: h.ReportBasis || null,
      currency: h.Currency || null,
    },
    totalIncome: totalIncome === null ? 0 : totalIncome,
    totalExpenses: figure(all, 'Expenses', /^total expenses$/i),
    netIncome: figure(all, 'NetIncome', /^net income$/i),
  };
}

module.exports = { parseProfitAndLoss, ProfitAndLossShapeError, amount };
