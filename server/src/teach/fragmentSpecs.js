// Buddy-018: fragment packs from docs/curriculum/bi-program-v002.md (machine-readable).
import { HttpError } from '../http.js';
import { TUAI_INTRO_PAGES } from '../notion/tuaiIntroCatalog.js';

function page(n) {
  const p = TUAI_INTRO_PAGES[n - 1];
  if (!p) throw new Error(`Нет страницы каталога №${n}`);
  return p;
}

function pack({
  fragmentId,
  title,
  pageN,
  sourceScope,
  concepts,
  prerequisites = [],
  learningGoal,
  taskType,
  successSigns,
}) {
  const p = page(pageN);
  return Object.freeze({
    fragmentId,
    programVersion: 'bi-program-v002',
    title,
    pageId: p.pageId,
    sourceUrl: p.sourceUrl,
    sourceScope: Array.isArray(sourceScope) ? sourceScope.join(' ') : sourceScope,
    concepts,
    prerequisites,
    learningGoal,
    taskType,
    successSigns,
  });
}

/** Experimental disclaimer shown to admin and embedded in API result. */
export function teachDisclaimer(fragmentId) {
  return [
    `Это экспериментальная проверка одного учебного цикла ${fragmentId}.`,
    'Успех здесь НЕ означает, что постоянный Би в обычном чате уже усвоил материал.',
    'Результат не записывается в память Би, KB или учения (кроме закрытых разногласий Создателя).',
  ].join(' ');
}

/**
 * Methodist packs — mirrors bi-program-v002.md §§ F01–F15.
 * Source text is loaded from the matching Notion page (expandLinkedPages: false).
 */
const FRAGMENT_SPECS = Object.freeze({
  F01: pack({
    fragmentId: 'F01',
    title: 'Инженер-философ и картина мира',
    pageN: 1,
    sourceScope: [
      'Сравнение трудов повара, инженера, учёного, философа, художника.',
      'Прямой и косвенный продукт; оценка потребителем.',
      'Инженер-философ; картина мира как продукт.',
    ],
    concepts: ['прямой vs косвенный продукт', 'оценка потребителем', 'инженер-философ', 'картина мира'],
    prerequisites: [],
    learningGoal: 'Отличать применимую философию от цеховой самооценки.',
    taskType: 'Два тезиса — какой ближе к инженер-философии и почему.',
    successSigns: ['критерий потребителя/применения', 'не «кто красивее сформулировал»', 'опора на метафоры источника'],
  }),
  F02: pack({
    fragmentId: 'F02',
    title: 'Четыре класса трудных вопросов',
    pageN: 2,
    sourceScope: ['Классы с кодами (468)(357)(246)(135).'],
    concepts: ['понимание (468)', 'оптимальность устройства (357)', 'правильное поведение (246)', 'выбор (135)'],
    prerequisites: ['F01'],
    learningGoal: 'Классифицировать новый вопрос.',
    taskType: 'Вопросы вне текста → классы + обоснование.',
    successSigns: ['без пятого класса', '357 ≠ 246', 'опора на коды источника'],
  }),
  F03: pack({
    fragmentId: 'F03',
    title: 'Отсечения и точки 1/3/5/7',
    pageN: 3,
    sourceScope: ['Точки 1,3,5,7; шкала; отсечение; мемы-ярлыки.'],
    concepts: ['шкала', 'отсечение', 'точки 1/3/5/7', 'мемы-ярлыки'],
    prerequisites: ['F02'],
    learningGoal: 'Сопоставить портрет с точкой выше/ниже.',
    taskType: 'Портреты → точки без «вечного типа».',
    successSigns: ['только введённые точки'],
  }),
  F04: pack({
    fragmentId: 'F04',
    title: 'Поле внимания и мощность',
    pageN: 4,
    sourceScope: ['Мышление с копией/знаком; мощность поля внимания.'],
    concepts: ['копия/знак', 'поле внимания', 'мощность поля'],
    prerequisites: ['F03'],
    learningGoal: 'Отличить дефицит знания от дефицита удержания структуры.',
    taskType: 'Две ошибки ученика — классификация.',
    successSigns: ['явное различение'],
  }),
  F05: pack({
    fragmentId: 'F05',
    title: 'Три шкалы и чётные уровни',
    pageN: 5,
    sourceScope: ['Геометрия → физика → отсечения; зачем чётные уровни.'],
    concepts: ['три колонки', 'уровни 1/3/5/7', 'чётные уровни'],
    prerequisites: ['F04'],
    learningGoal: 'Переводить между колонками таблицы.',
    taskType: 'Уровень в одной колонке → две другие + бытовой пример.',
    successSigns: ['таблица не искажена'],
  }),
  F06: pack({
    fragmentId: 'F06',
    title: 'Возраст, норма, закон трудных побед',
    pageN: 5,
    sourceScope: ['Лестница возрастов; норма; закон взросления; опыт трудных побед.'],
    concepts: ['возрастные окна', 'норма', 'опыт трудных побед'],
    prerequisites: ['F05'],
    learningGoal: 'Связать уровень-возможность с закреплением через трудные задачи.',
    taskType: 'Кейс: окно уровня и тип закрепляющей задачи (не диагноз).',
    successSigns: ['лестница автора', 'норма ≠ максимум', 'закрепление победой'],
  }),
  F07: pack({
    fragmentId: 'F07',
    title: 'Три направления психологии',
    pageN: 6,
    sourceScope: ['Типы / стадии / мгновенные состояния; пространство состояний.'],
    concepts: ['типы', 'стадии', 'мгновенные состояния'],
    prerequisites: ['F06'],
    learningGoal: 'Выбрать режим анализа кейса.',
    taskType: 'Кейсы → тип/стадия/состояние.',
    successSigns: ['не смешивать вечный тип с репликой'],
  }),
  F08: pack({
    fragmentId: 'F08',
    title: 'Задача как зонд',
    pageN: 7,
    sourceScope: ['Чёрный ящик; потребность задачи ↔ способность; валюты.'],
    concepts: ['чёрный ящик', 'потребность ↔ способность', 'поток задач'],
    prerequisites: ['F07'],
    learningGoal: 'Разбирать провал как несоответствие пары.',
    taskType: 'Провал → потребность + гипотеза способности.',
    successSigns: ['обе стороны пары', 'проверяемая гипотеза'],
  }),
  F09: pack({
    fragmentId: 'F09',
    title: 'Параметры потребностей задачи',
    pageN: 8,
    sourceScope: ['Время, кодировки, сложность, контекст.'],
    concepts: ['время', 'кодировки', 'сложность', 'контекст'],
    prerequisites: ['F08'],
    learningGoal: 'Менять параметры задачи осознанно.',
    taskType: 'Одна задача → модификации из разных групп + прогноз.',
    successSigns: ['все четыре группы узнаваемы'],
  }),
  F10: pack({
    fragmentId: 'F10',
    title: 'Четыре грани деятельности',
    pageN: 9,
    sourceScope: ['Матрица я/мы × думать/делать.'],
    concepts: ['мышление', 'поведение', 'со-знание', 'взаимодействие'],
    prerequisites: ['F09'],
    learningGoal: 'Отнести сцену к грани.',
    taskType: 'Сцены → грани.',
    successSigns: ['различение «думаем вместе» / «делаем вместе»'],
  }),
  F11: pack({
    fragmentId: 'F11',
    title: 'Мышление: инструменты по уровням',
    pageN: 10,
    sourceScope: ['Таблица вопросов/операций/категорий × уровни 1–8.'],
    concepts: ['инструменты мышления', 'уровни 1–8'],
    prerequisites: ['F10'],
    learningGoal: 'Подбирать инструмент нужного уровня.',
    taskType: 'Проблема → вопрос + операция уровня.',
    successSigns: ['согласовано с таблицей источника'],
  }),
  F12: pack({
    fragmentId: 'F12',
    title: 'Со-знание: типы',
    pageN: 11,
    sourceScope: ['Таблица типов со-знания; позитив/негатив.'],
    concepts: ['со-знание', 'типы со-знания'],
    prerequisites: ['F11'],
    learningGoal: 'Опознать тип по речи сообщества.',
    taskType: 'Фрагмент речи → тип + пара позитив/негатив.',
    successSigns: ['таблица не искажена', 'не путать с одиночным мышлением'],
  }),
  F13: pack({
    fragmentId: 'F13',
    title: 'Взаимодействие: уровни',
    pageN: 12,
    sourceScope: ['Таблица уровней взаимодействия 1–8.'],
    concepts: ['уровни взаимодействия'],
    prerequisites: ['F12'],
    learningGoal: 'Классифицировать социальную ситуацию по уровню таблицы.',
    taskType: 'Ситуации → уровень + обоснование.',
    successSigns: ['уровни из источника', 'не «тип личности навсегда»'],
  }),
  F14: pack({
    fragmentId: 'F14',
    title: 'Поведение как предметная проекция',
    pageN: 12,
    sourceScope: ['Поведение как грань; разные предметные проекции (без выдуманной таблицы).'],
    concepts: ['поведение', 'предметные проекции'],
    prerequisites: ['F13'],
    learningGoal: 'Не смешивать описание поведения с со-знанием.',
    taskType: 'Одна сцена — два описания (поведение vs со-знание).',
    successSigns: ['различие рамок сохранено'],
  }),
  F15: pack({
    fragmentId: 'F15',
    title: 'Музыка — иллюстрация уровней',
    pageN: 13,
    sourceScope: ['Уровни 1–8 на музыке как иллюстрация шкалы.'],
    concepts: ['номер = уровень ситуации', 'перенос шкалы'],
    prerequisites: ['F05', 'F10'],
    learningGoal: 'Переносить шкалу на новую область.',
    taskType: 'Новая область — 8 ступеней по росту организации.',
    successSigns: ['монотонный рост сложности', 'аналогия, не копия примеров'],
  }),
});

/** Logical teaching order (Creator-approved default for bi-program-v002). */
export const DEFAULT_CHAIN_IDS = Object.freeze([
  'F01', 'F02', 'F03', 'F04', 'F05', 'F06', 'F07', 'F08',
  'F09', 'F10', 'F11', 'F12', 'F13', 'F14', 'F15',
]);

export const ALLOWED_FRAGMENT_IDS = Object.freeze(Object.keys(FRAGMENT_SPECS));

/**
 * @param {string} fragmentId
 * @returns {Readonly<(typeof FRAGMENT_SPECS)[keyof typeof FRAGMENT_SPECS]>}
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

export function listFragmentSpecs() {
  return DEFAULT_CHAIN_IDS.map((id) => {
    const s = FRAGMENT_SPECS[id];
    return {
      fragmentId: s.fragmentId,
      title: s.title,
      pageId: s.pageId,
      prerequisites: s.prerequisites,
      learningGoal: s.learningGoal,
    };
  });
}

/** @deprecated use getFragmentSpec('F01') */
export const F01_SPEC = FRAGMENT_SPECS.F01;
export const F01_EXPERIMENT_DISCLAIMER = teachDisclaimer('F01');
