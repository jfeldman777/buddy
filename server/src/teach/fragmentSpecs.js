// Buddy-018 step 5: fragment packs from docs/curriculum/bi-program-v002.md (machine-readable).
import { HttpError } from '../http.js';
import { TUAI_INTRO_PAGES } from '../notion/tuaiIntroCatalog.js';

const page1 = TUAI_INTRO_PAGES[0];
const page2 = TUAI_INTRO_PAGES[1];

/** Experimental disclaimer shown to admin and embedded in API result. */
export function teachDisclaimer(fragmentId) {
  return [
    `Это экспериментальная проверка одного учебного цикла ${fragmentId}.`,
    'Успех здесь НЕ означает, что постоянный Би в обычном чате уже усвоил материал.',
    'Результат не записывается в память Би, KB или учения.',
  ].join(' ');
}

/**
 * Methodist packs for allowed fragments — mirrors bi-program-v002.md §§ F01–F02.
 * Source text is loaded from the matching Notion page (expandLinkedPages: false).
 */
const FRAGMENT_SPECS = Object.freeze({
  F01: Object.freeze({
    fragmentId: 'F01',
    programVersion: 'bi-program-v002',
    title: 'Инженер-философ и картина мира',
    pageId: page1.pageId,
    sourceUrl: page1.sourceUrl,
    sourceScope: [
      'Сравнение трудов повара, инженера, учёного, философа, художника.',
      'Прямой и косвенный продукт; оценка потребителем, а не только цехом специалистов.',
      'Инженер-философ ждёт оценки применения; картина мира как продукт.',
    ].join(' '),
    concepts: [
      'прямой vs косвенный продукт',
      'оценка потребителем',
      'инженер-философ',
      'картина мира как продукт мышления',
    ],
    prerequisites: [],
    learningGoal: 'Отличать применимую философию от цеховой самооценки.',
    taskType: 'Два тезиса — какой ближе к инженер-философии и почему (без апелляции к авторитету автора как таковому).',
    successSigns: [
      'есть критерий потребителя/применения',
      'не сводится к «кто красивее сформулировал»',
      'опора на метафоры источника',
    ],
  }),
  F02: Object.freeze({
    fragmentId: 'F02',
    programVersion: 'bi-program-v002',
    title: 'Четыре класса трудных вопросов',
    pageId: page2.pageId,
    sourceUrl: page2.sourceUrl,
    sourceScope: [
      'Четыре класса трудных вопросов с кодами (468), (357), (246), (135).',
      'Различение понимания, оптимальности устройства, правильного поведения и выбора.',
    ].join(' '),
    concepts: [
      'понимание (468)',
      'оптимальность устройства (357)',
      'правильное поведение (246)',
      'выбор (135)',
    ],
    prerequisites: ['F01'],
    learningGoal: 'Классифицировать новый вопрос.',
    taskType: 'Несколько вопросов вне текста → классы + обоснование (в цикле — 3 задачи на применение).',
    successSigns: [
      'без пятого выдуманного класса',
      '357 ≠ 246 (устройство ≠ поведение)',
      'опора на коды/определения источника',
    ],
  }),
});

/** Step 5 allowlist — F03–F15 blocked until Creator opens them. */
export const ALLOWED_FRAGMENT_IDS = Object.freeze(Object.keys(FRAGMENT_SPECS));

/**
 * @param {string} fragmentId
 * @returns {Readonly<typeof FRAGMENT_SPECS[keyof typeof FRAGMENT_SPECS]>}
 */
export function getFragmentSpec(fragmentId) {
  const id = String(fragmentId || '').trim().toUpperCase();
  const spec = FRAGMENT_SPECS[id];
  if (!spec) {
    throw new HttpError(
      400,
      'teach_fragment_not_allowed',
      `Фрагмент «${fragmentId || ''}» недоступен. Разрешены: ${ALLOWED_FRAGMENT_IDS.join(', ')}.`,
    );
  }
  return spec;
}

/** @deprecated use getFragmentSpec('F01') — kept for step-4 import compatibility in tests if needed */
export const F01_SPEC = FRAGMENT_SPECS.F01;
export const F01_EXPERIMENT_DISCLAIMER = teachDisclaimer('F01');
