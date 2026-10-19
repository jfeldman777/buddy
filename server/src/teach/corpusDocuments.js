// Buddy-018 step 8A-files: store extracted PDF/DOCX texts for Creator teaching.
import { HttpError } from '../http.js';

const DOC_TEXT_MAX = 200_000;
const DOC_COUNT_MAX = 40;
const FILENAME_MAX = 200;

function nowIso() {
  return new Date().toISOString();
}

function mapDoc(row, { withText = false } = {}) {
  const base = {
    id: row.id,
    adminId: row.admin_id,
    filename: row.filename,
    title: row.title || '',
    kind: row.kind,
    charCount: Number(row.char_count) || 0,
    createdAt: row.created_at,
  };
  if (withText) base.text = row.text || '';
  return base;
}

export async function listCorpusDocuments(env, { adminId, withText = false } = {}) {
  const admin = String(adminId || '');
  if (!admin) throw new HttpError(401, 'unauthorized', 'Нужен администратор.');
  const cols = withText
    ? 'id, admin_id, filename, title, kind, text, char_count, created_at'
    : 'id, admin_id, filename, title, kind, char_count, created_at';
  const { results } = await env.DB.prepare(
    `SELECT ${cols} FROM teach_corpus_documents WHERE admin_id = ?1 ORDER BY created_at ASC`,
  ).bind(admin).all();
  return (results || []).map((r) => mapDoc(r, { withText }));
}

export async function getCorpusDocumentsByIds(env, { adminId, ids, withText = true } = {}) {
  const admin = String(adminId || '');
  const list = Array.isArray(ids) ? ids.map((x) => String(x || '').trim()).filter(Boolean) : [];
  if (!list.length) return [];
  const docs = [];
  for (const id of list) {
    const row = await env.DB.prepare(
      `SELECT id, admin_id, filename, title, kind, text, char_count, created_at
       FROM teach_corpus_documents WHERE id = ?1 AND admin_id = ?2`,
    ).bind(id, admin).first();
    if (!row) throw new HttpError(404, 'teach_corpus_doc_not_found', `Документ корпуса не найден: ${id}`);
    docs.push(mapDoc(row, { withText }));
  }
  return docs;
}

export async function addCorpusDocument(env, {
  adminId,
  filename,
  title,
  kind,
  text,
} = {}) {
  const admin = String(adminId || '');
  if (!admin) throw new HttpError(401, 'unauthorized', 'Нужен администратор.');

  const k = String(kind || '').toLowerCase();
  if (!['pdf', 'docx', 'text'].includes(k)) {
    throw new HttpError(400, 'teach_corpus_kind', 'Тип файла: pdf, docx или text.');
  }
  const name = String(filename || '').trim().slice(0, FILENAME_MAX);
  if (!name) throw new HttpError(400, 'teach_corpus_filename', 'Нужно имя файла.');

  const body = String(text || '');
  if (!body.trim()) {
    throw new HttpError(400, 'teach_corpus_empty', `Файл «${name}»: текст пуст (у PDF без текстового слоя нужен OCR — позже).`);
  }
  if (body.length > DOC_TEXT_MAX) {
    throw new HttpError(413, 'teach_corpus_too_long', `Файл «${name}»: больше ${DOC_TEXT_MAX} символов текста.`);
  }

  const countRow = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM teach_corpus_documents WHERE admin_id = ?1',
  ).bind(admin).first();
  if (Number(countRow?.n) >= DOC_COUNT_MAX) {
    throw new HttpError(409, 'teach_corpus_full', `В корпусе уже ${DOC_COUNT_MAX} файлов. Удалите лишние или очистите корпус.`);
  }

  const doc = {
    id: crypto.randomUUID(),
    adminId: admin,
    filename: name,
    title: String(title || name).trim().slice(0, FILENAME_MAX) || name,
    kind: k,
    text: body,
    charCount: body.length,
    createdAt: nowIso(),
  };
  await env.DB.prepare(
    `INSERT INTO teach_corpus_documents
      (id, admin_id, filename, title, kind, text, char_count, created_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8)`,
  ).bind(
    doc.id,
    doc.adminId,
    doc.filename,
    doc.title,
    doc.kind,
    doc.text,
    doc.charCount,
    doc.createdAt,
  ).run();
  return mapDoc({
    id: doc.id,
    admin_id: doc.adminId,
    filename: doc.filename,
    title: doc.title,
    kind: doc.kind,
    text: doc.text,
    char_count: doc.charCount,
    created_at: doc.createdAt,
  }, { withText: false });
}

export async function clearCorpusDocuments(env, { adminId } = {}) {
  const admin = String(adminId || '');
  if (!admin) throw new HttpError(401, 'unauthorized', 'Нужен администратор.');
  await env.DB.prepare('DELETE FROM teach_corpus_documents WHERE admin_id = ?1').bind(admin).run();
  return { cleared: true };
}

/** Map stored docs into session "pages" shape for the teach prompt. */
export function documentsToPages(docs) {
  return (docs || []).map((d, i) => ({
    n: i + 1,
    pageId: d.id,
    title: d.title || d.filename,
    text: d.text || '',
    charCount: d.charCount || (d.text || '').length,
    status: (d.text || '').trim() ? 'ok' : 'incomplete',
    source: 'file',
    kind: d.kind,
    filename: d.filename,
  }));
}

export const __test = { DOC_TEXT_MAX, DOC_COUNT_MAX, documentsToPages };
