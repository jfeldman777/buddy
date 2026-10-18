// Buddy-018 step 4: F01 lesson pack from docs/curriculum/bi-program-v002.md (exact fragment, not whole corpus).
import { TUAI_INTRO_PAGES } from '../notion/tuaiIntroCatalog.js';

const page1 = TUAI_INTRO_PAGES[0];

/** Experimental disclaimer shown to admin and embedded in API result. */
export const F01_EXPERIMENT_DISCLAIMER = [
  'Это экспериментальная проверка одного учебного цикла F01.',
  'Успех здесь НЕ означает, что постоянный Би в обычном чате уже усвоил материал.',
  'Результат не записывается в память Би, KB или учения.',
].join(' ');

/**
 * Methodist pack for F01 — mirrors bi-program-v002.md § F01.
 * Source text is loaded from Notion page 1 only (expandLinkedPages: false).
 */
export const F01_SPEC = Object.freeze({
  fragmentId: 'F01',
  programVersion: 'bi-program-v002',
  title: 'Инженер-философ и картина мира',
  pageId: page1.pageId,
  sourceUrl: page1.sourceUrl,
  /** What of the page is in scope (Methodist constraint). */
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
});
