import { buildMessageSrcDoc, IFRAME_CSP } from './message-html';

interface MessagePrintContent {
  subject: string;
  headers: [label: string, value: string][];
  sanitizedHtml: string;
  text: string;
}

const PRINT_CSS = `
  html, body { height: auto !important; min-height: 0 !important; overflow: visible !important; }
  .stormbox-print-header {
    background: white; color: black; text-align: start; font: 10pt / 1.4 sans-serif;
    border-bottom: 1px solid #aaa; padding-bottom: 12pt; margin: 0 0 12pt;
    break-inside: avoid; overflow-wrap: anywhere;
  }
  .stormbox-print-header h1 { font: bold 16pt / 1.3 sans-serif; margin: 0 0 6pt; }
  .stormbox-print-header dl { margin: 0; }
  .stormbox-print-header dt { display: inline; font-weight: bold; }
  .stormbox-print-header dd { display: inline; margin: 0; }
  .stormbox-print-text { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
`;

export function printMessage({ subject, headers, sanitizedHtml, text }: MessagePrintContent): () => void {
  const doc = new DOMParser().parseFromString(buildMessageSrcDoc(sanitizedHtml), 'text/html');
  // The print document also contains recipient metadata, including Bcc.
  doc.head.querySelector('meta[http-equiv="Content-Security-Policy"]')?.setAttribute(
    'content', IFRAME_CSP.replace(/font-src [^;]+/, "font-src 'none'"),
  );
  doc.title = subject;
  const style = doc.createElement('style');
  style.textContent = PRINT_CSS;
  doc.head.append(style);

  const header = doc.createElement('header');
  header.className = 'stormbox-print-header';
  const title = doc.createElement('h1');
  title.textContent = subject;
  const metadata = doc.createElement('dl');
  for (const [label, value] of headers) {
    if (!value) continue;
    const row = doc.createElement('div');
    const term = doc.createElement('dt');
    term.textContent = `${label}: `;
    const detail = doc.createElement('dd');
    detail.textContent = value;
    row.append(term, detail);
    metadata.append(row);
  }
  header.append(title, metadata);
  doc.body.prepend(header);

  if (!sanitizedHtml) {
    const body = doc.createElement('div');
    body.className = 'stormbox-print-text';
    body.textContent = text;
    doc.body.append(body);
  }
  doc.querySelectorAll('img[loading="lazy"]').forEach((image) => image.removeAttribute('loading'));

  const frame = document.createElement('iframe');
  frame.title = 'Print email';
  frame.tabIndex = -1;
  frame.setAttribute('aria-hidden', 'true');
  frame.setAttribute('sandbox', 'allow-same-origin allow-modals');
  frame.referrerPolicy = 'no-referrer';
  frame.style.cssText = 'position: fixed; left: -10000px; top: 0; width: 800px; height: 1px; border: 0;';
  frame.srcdoc = `<!DOCTYPE html>\n${doc.documentElement.outerHTML}`;

  const remove = () => frame.remove();
  frame.addEventListener('load', () => {
    const printWindow = frame.contentWindow;
    if (!printWindow?.print) return remove();
    printWindow.addEventListener('afterprint', remove, { once: true });
    printWindow.print();
  }, { once: true });
  document.body.append(frame);
  return remove;
}
