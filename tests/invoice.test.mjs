import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';
import { createDemoAccount, submitRequest, transitionRequest } from '../src/services/credits.mjs';
import { createTaskInvoice, invoiceData } from '../src/services/invoice.mjs';

const assets = {
  font: await readFile(new URL('../public/fonts/GeistMono-Regular.ttf', import.meta.url)),
  logo: await readFile(new URL('../public/wwl-logomark.svg', import.meta.url), 'utf8'),
};

test('invoice uses the task owner, actual credits, and stable task date', () => {
  const account = createDemoAccount();
  const invoice = invoiceData(account, 'request-1');
  assert.equal(invoice.date, '9.28.2026');
  assert.equal(invoice.filename, 'windward-request-1-invoice.pdf');
  assert.equal(invoice.rows[0][1], 'Example Studio\nalex@example.com');
  assert.match(invoice.rows.at(-1)[1], /^4 credits\nCharged/);
  assert.throws(() => invoiceData(account, 'missing'));
});

test('pending, cancelled, and declined tasks never claim a credit charge', () => {
  for (const status of ['reserved', 'cancelled', 'declined']) {
    const account = createDemoAccount();
    if (status !== 'reserved') transitionRequest(account, status === 'declined' ? 'studio' : 'sam', 'request-2', status);
    const fee = invoiceData(account, 'request-2').rows.at(-1)[1];
    assert.match(fee, status === 'reserved' ? /not yet charged/ : /no credits charged/);
    assert.doesNotMatch(fee, /Charged against/);
  }
});

test('Fast invoice preserves purchased work time separately from credit cost', () => {
  const account = createDemoAccount();
  const request = submitRequest(account, 'studio', 'sam', 'Review', 8, 'fast');
  const invoice = invoiceData(account, request.id);
  assert.match(invoice.rows[0][1], /sam@example.com/);
  assert.match(invoice.rows[3][1], /2 hours of work\nFast delivery: 24h/);
  assert.match(invoice.rows[4][1], /^12 credits/);
});

test('sample invoice is a one-page Letter PDF with a clear sample identity', async () => {
  const result = await createTaskInvoice(createDemoAccount(), 'request-1', assets);
  const pdf = await PDFDocument.load(result.bytes);
  assert.equal(pdf.getPageCount(), 1);
  assert.deepEqual(pdf.getPage(0).getSize(), { width: 612, height: 792 });
  assert.match(pdf.getTitle(), /Sample task invoice/);
  assert.match(pdf.getSubject(), /Not a tax invoice/);
});

test('a long brief paginates; unsupported characters fail explicitly', async () => {
  const account = createDemoAccount();
  const request = submitRequest(account, 'sam', 'sam', 'Requirements and acceptance criteria. '.repeat(50), 4);
  const result = await createTaskInvoice(account, request.id, assets);
  const pdf = await PDFDocument.load(result.bytes);
  assert.ok(pdf.getPageCount() > 1);
  request.brief = 'Unsupported glyph: \u{10FFFF}';
  await assert.rejects(createTaskInvoice(account, request.id, assets), /cannot render/);
});
