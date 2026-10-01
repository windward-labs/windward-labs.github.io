import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const LEFT = 28;
const VALUE_X = 260;
const RIGHT = 28;
const SIZE = 11;
const LEADING = 16;
const ROW_BOTTOM = 712;

const statusNames = { reserved: 'Pending acceptance', accepted: 'In progress', completed: 'Completed', declined: 'Declined', cancelled: 'Cancelled' };

export function invoiceData(account, requestId) {
  const request = account.requests.find((request) => request.id === requestId);
  if (!request) throw new Error('Task not found.');
  const member = account.members.find((member) => member.id === request.memberId);
  if (!member) throw new Error('Task owner not found.');
  const submitted = account.events.find((event) => event.requestId === requestId && event.action === 'reserved');
  if (!submitted || !Number.isFinite(Date.parse(submitted.at))) throw new Error('Task date is missing.');
  const charged = ['accepted', 'completed'].includes(request.status);
  const released = ['cancelled', 'declined'].includes(request.status);
  if (!charged && !released && request.status !== 'reserved') throw new Error('Unknown task status.');
  if (!Number.isSafeInteger(request.credits) || request.credits <= 0) throw new Error('Invalid task credit amount.');
  const date = new Date(submitted.at);
  return {
    id: `WWL-${request.id.toUpperCase()}`,
    date: `${date.getUTCMonth() + 1}.${date.getUTCDate()}.${date.getUTCFullYear()}`,
    filename: `windward-${request.id.replace(/[^a-z0-9-]/gi, '-')}-invoice.pdf`,
    rows: [
      ['CLIENT', `${account.name || 'Example Studio'}\n${member.email}`],
      ['PROJECT', `${request.id}\n${request.level}`],
      ['DELIVERABLES', request.brief],
      ['TIMING', `${request.time} of work\n${request.speed === 'fast' ? 'Fast' : 'Normal'} delivery: ${request.deliveryHours}h\n${statusNames[request.status]}`],
      ['FEE', `${request.credits} credits\n${charged ? 'Charged against prepaid balance' : released ? 'Hold released; no credits charged' : 'Held pending acceptance; not yet charged'}`],
    ],
  };
}

// Word-wrap and split long URLs/identifiers without dropping task text.
function wrapText(text, font, width) {
  const lines = [];
  for (const paragraph of String(text).replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n')) {
    if (!paragraph.trim()) { lines.push(''); continue; }
    let line = '';
    for (const word of paragraph.trim().split(/\s+/)) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, SIZE) <= width) { line = candidate; continue; }
      if (line) { lines.push(line); line = ''; }
      for (const character of word) {
        if (line && font.widthOfTextAtSize(line + character, SIZE) > width) { lines.push(line); line = ''; }
        line += character;
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}

export async function createTaskInvoice(account, requestId, assets) {
  const data = invoiceData(account, requestId);
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const font = await pdf.embedFont(assets.font, { subset: true });
  const allowed = new Set(font.getCharacterSet());
  for (const value of [data.id, data.date, ...data.rows.flat()]) {
    for (const char of value) {
      if (!/\s/.test(char) && !allowed.has(char.codePointAt(0))) throw new Error(`The invoice font cannot render “${char}”. Please use a supported character in the task brief.`);
    }
  }
  pdf.setTitle(`${data.id} - Sample task invoice`);
  pdf.setAuthor('Windward Labs');
  pdf.setSubject('Sample credit invoice. Not a tax invoice.');
  const logoPaths = [...assets.logo.matchAll(/<path\b[^>]*\bd="([^"]+)"/g)].map((match) => match[1]);
  if (!logoPaths.length) throw new Error('Invoice logo is missing.');
  const ink = rgb(0, 0, 0);
  let page;
  let top;
  const drawText = (text, x, y, size = SIZE) => page.drawText(text, { x, y: PAGE_HEIGHT - y - size, font, size, color: ink });
  const line = (y) => page.drawLine({ start: { x: 0, y: PAGE_HEIGHT - y }, end: { x: PAGE_WIDTH, y: PAGE_HEIGHT - y }, thickness: 1, color: ink });
  const newPage = () => {
    page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    drawText('Windward Labs', LEFT, 26);
    drawText(data.date, PAGE_WIDTH - RIGHT - font.widthOfTextAtSize(data.date, SIZE), 26);
    drawText('TASK INVOICE', LEFT, 140);
    drawText(data.id, VALUE_X, 140);
    drawText('SAMPLE - NOT A TAX INVOICE', LEFT, 160, 8);
    for (const path of logoPaths) page.drawSvgPath(path, { x: 22, y: 36, scale: 0.09, color: ink });
    top = 180;
  };
  newPage();
  for (const [label, value] of data.rows) {
    let lines = wrapText(value, font, PAGE_WIDTH - VALUE_X - RIGHT);
    let continued = false;
    while (lines.length) {
      if (ROW_BOTTOM - top < 48) newPage();
      const capacity = Math.floor((ROW_BOTTOM - top - 28) / LEADING);
      const chunk = lines.splice(0, Math.max(1, capacity));
      const height = Math.max(48, chunk.length * LEADING + 28);
      line(top);
      drawText(continued ? `${label} (CONT.)` : label, LEFT, top + 12);
      chunk.forEach((text, index) => drawText(text, VALUE_X, top + 12 + index * LEADING));
      top += height;
      line(top);
      if (lines.length) { continued = true; newPage(); }
    }
  }
  const pages = pdf.getPages();
  for (let index = 0; index < pages.length; index++) {
    const text = `${index + 1} / ${pages.length}`;
    pages[index].drawText(text, { x: PAGE_WIDTH - RIGHT - font.widthOfTextAtSize(text, 8), y: 24, font, size: 8, color: ink });
  }
  return { bytes: await pdf.save(), filename: data.filename };
}

let assetPromise;
export async function downloadTaskInvoice(account, requestId) {
  assetPromise ??= Promise.all(['/fonts/GeistMono-Regular.ttf', '/wwl-logomark.svg'].map(async (url) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error('Invoice assets could not be loaded. Please try again.');
    return url.endsWith('.svg') ? response.text() : response.arrayBuffer();
  })).catch((error) => { assetPromise = undefined; throw error; });
  const [font, logo] = await assetPromise;
  const { bytes, filename } = await createTaskInvoice(account, requestId, { font, logo });
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
