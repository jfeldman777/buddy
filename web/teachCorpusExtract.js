// Buddy-018 8A-files: extract plain text from PDF / DOCX in the browser.

const DOCX_CDN = 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm';
const PDF_CDN = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/+esm';
const PDF_WORKER = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';

function decodeXmlEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

/** Minimal DOCX → text via document.xml word runs. */
export async function extractDocxText(arrayBuffer) {
  const { default: JSZip } = await import(DOCX_CDN);
  const zip = await JSZip.loadAsync(arrayBuffer);
  const xml = await zip.file('word/document.xml')?.async('string');
  if (!xml) throw new Error('В DOCX нет word/document.xml');
  const parts = [];
  const re = /<w:t[^>]*>([^<]*)<\/w:t>|<w:tab\/>|<w:br\/>|<\/w:p>/g;
  let m;
  while ((m = re.exec(xml))) {
    if (m[0] === '</w:p>') parts.push('\n');
    else if (m[0] === '<w:tab/>') parts.push('\t');
    else if (m[0] === '<w:br/>') parts.push('\n');
    else parts.push(decodeXmlEntities(m[1]));
  }
  return parts.join('').replace(/\n{3,}/g, '\n\n').trim();
}

/** PDF text layer via PDF.js (no OCR). */
export async function extractPdfText(arrayBuffer) {
  const pdfjs = await import(PDF_CDN);
  if (pdfjs.GlobalWorkerOptions) {
    pdfjs.GlobalWorkerOptions.workerSrc = PDF_WORKER;
  }
  const doc = await pdfjs.getDocument({ data: arrayBuffer }).promise;
  const chunks = [];
  for (let i = 1; i <= doc.numPages; i += 1) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const line = (content.items || []).map((it) => it.str || '').join(' ');
    if (line.trim()) chunks.push(line);
  }
  return chunks.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * @param {File} file
 * @returns {Promise<{ kind: 'pdf'|'docx', filename: string, title: string, text: string }>}
 */
export async function extractTeachFile(file) {
  const name = file?.name || 'file';
  const lower = name.toLowerCase();
  const buf = await file.arrayBuffer();
  let kind;
  let text;
  if (lower.endsWith('.docx')) {
    kind = 'docx';
    text = await extractDocxText(buf);
  } else if (lower.endsWith('.pdf')) {
    kind = 'pdf';
    text = await extractPdfText(buf);
  } else {
    throw new Error(`Поддерживаются только PDF и DOCX: ${name}`);
  }
  if (!text) {
    throw new Error(
      kind === 'pdf'
        ? `«${name}»: нет текстового слоя (скан). OCR пока не поддерживается.`
        : `«${name}»: текст не извлечён.`,
    );
  }
  return {
    kind,
    filename: name,
    title: name.replace(/\.(pdf|docx)$/i, ''),
    text,
  };
}
