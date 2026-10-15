// Scripted acquaintance with Bi. Pure functions without DOM, so the flow is testable in Node.
// Bi addresses the person as «ты»; Bi himself is masculine. Lines avoid gendered verbs about the person.

export const MAX_NAME_LENGTH = 40;

export const VOICE_SAMPLE = 'Привет! Я Би. Буду говорить так.';

export const prompts = {
  changeVoice: 'Выбери, каким голосом мне говорить.',
  changeName: 'Как мне тебя называть?',
  noVoicesHere: 'На этом устройстве нет русского голоса, так что я могу только писать.',
  voiceFound: 'Голос появился! Выбери, каким мне говорить.',
  voiceStillMissing: 'Пока не вижу русского голоса. Закрой Buddy полностью и открой снова — иногда браузер замечает новый голос только после перезапуска.',
  thanksForRating: 'Спасибо! Оценку можно поменять и дописать комментарий в журнале.',
};

export function normalizeName(raw) {
  const name = String(raw ?? '')
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!name) return { ok: false, reply: 'Напиши, пожалуйста, как к тебе обращаться.' };
  if (name.length > MAX_NAME_LENGTH) return { ok: false, reply: 'Длинновато. Как тебя называть коротко?' };
  return { ok: true, name };
}

export function pickVoices(voices, limit = 8) {
  const seen = new Set();
  return voices
    .filter((voice) => /^ru([-_]|$)/i.test(voice.lang))
    .filter((voice) => !seen.has(voice.voiceURI) && seen.add(voice.voiceURI))
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'))
    .slice(0, limit);
}

export function findVoice(voices, saved) {
  if (!saved) return null;
  return voices.find((voice) => voice.voiceURI === saved.uri) ?? voices.find((voice) => voice.name === saved.name) ?? null;
}

// What Bi says when the conversation opens, and which step follows.
// step: 'chooseVoice' | 'askName' | 'idle'; mode: 'voice' | 'text' | null (not chosen yet);
// act: the journal kind of Bi's act, or null when the opening is not a significant act.
export function opening({ profile, speechSupported, voices }) {
  const name = profile?.name;
  const canSpeak = speechSupported && voices.length > 0;

  if (!name) {
    if (profile?.mode) {
      return { messages: ['Привет ещё раз! Мы не договорили. Как мне тебя называть?'], step: 'askName', mode: profile.mode, act: null };
    }
    if (!speechSupported) {
      return {
        messages: ['Привет! Я Би. На этом устройстве я не могу говорить вслух, так что будем переписываться. А как мне тебя называть?'],
        step: 'askName',
        mode: 'text',
        act: 'text_forced',
      };
    }
    if (!canSpeak) {
      return {
        messages: ['Привет! Я Би. На этом устройстве нет русского голоса, так что пока будем переписываться. А как мне тебя называть?'],
        step: 'askName',
        mode: 'text',
        act: 'text_forced',
      };
    }
    return { messages: ['Привет! Я Би. Сначала выбери, каким голосом мне говорить.'], step: 'chooseVoice', mode: null, act: null };
  }

  if (profile.mode === 'voice' && !findVoice(voices, profile.voice)) {
    if (!canSpeak) {
      return { messages: [`Привет, ${name}! Рад снова тебя видеть. Голоса, которым я говорил, здесь нет, так что пока буду писать.`], step: 'idle', mode: 'text', act: 'voice_missing' };
    }
    return { messages: [`Привет, ${name}! Рад снова тебя видеть. Голоса, которым я говорил, здесь нет. Выбери другой.`], step: 'chooseVoice', mode: null, act: 'voice_missing' };
  }

  // Text mode was forced by a missing voice, not chosen by the person: offer a voice once one appears.
  if (profile.mode === 'text' && !profile.voiceDeclined && canSpeak) {
    return {
      messages: [`Привет, ${name}! Рад снова тебя видеть. Теперь у меня есть русский голос — выбери, каким мне говорить.`],
      step: 'chooseVoice',
      mode: 'text',
      act: 'voice_offered',
    };
  }

  return { messages: [`Привет, ${name}! Рад снова тебя видеть.`], step: 'idle', mode: profile.mode ?? 'text', act: 'recognized' };
}

const NOTHING_SENT = { sentData: false, usedDevices: false };

// Bi's own short, checkable explanation of each scripted act. It is Bi's account, not a record of what happened:
// the program records facts separately, and the compliance check compares the two.
export function explainAct(kind, ctx = {}) {
  const acts = {
    recognized: {
      title: 'Би узнал при новой встрече',
      situation: `Buddy открыли снова. На этом устройстве сохранено имя «${ctx.name}»${ctx.voiceName ? ` и голос «${ctx.voiceName}»` : ''}.`,
      goal: 'Продолжить знакомство, а не начинать заново.',
      decision: `Поздороваться по имени${ctx.voiceName ? ' и говорить прежним голосом' : ''}.`,
      motive: 'Обещал запомнить имя и выбор голоса и использовать их при следующих встречах.',
      declarations: ['D3'],
    },
    text_forced: {
      title: 'Би перешёл на переписку',
      situation: ctx.speechSupported === false ? 'Браузер на этом устройстве не умеет говорить вслух.' : 'На этом устройстве нет русского голоса.',
      goal: 'Начать знакомство, даже если говорить вслух не получается.',
      decision: ctx.speechSupported === false ? 'Переписываться текстом.' : 'Переписываться текстом и показать, как добавить русский голос.',
      motive: 'Честно сказать, чего не могу, и оставить решение — добавлять голос или нет — за человеком.',
      declarations: ['D4', 'D6'],
    },
    voice_missing: {
      title: 'Би не нашёл прежний голос',
      situation: `Голоса «${ctx.voiceName ?? 'выбранного раньше'}» на этом устройстве нет.`,
      goal: 'Не делать вид, что всё как раньше.',
      decision: ctx.canSpeak ? 'Сказать об этом и предложить выбрать другой голос.' : 'Сказать об этом и пока писать текстом.',
      motive: 'Сказать о том, что изменилось, а выбор нового голоса оставить человеку.',
      declarations: ['D3', 'D4', 'D6'],
    },
    voice_offered: {
      title: 'Би предложил голос',
      situation: 'Раньше русского голоса не было, теперь он есть. От голоса никто не отказывался.',
      goal: 'Дать возможность говорить вслух.',
      decision: 'Предложить выбрать голос. Можно отказаться и остаться в переписке.',
      motive: 'Переписка была вынужденной, а не выбором человека. Предложить один раз и принять отказ.',
      declarations: ['D7', 'D6'],
    },
    voice_found: {
      title: 'Би нашёл русский голос',
      situation: 'После установки голоса пришёл запрос проверить ещё раз, и русский голос нашёлся.',
      goal: 'Дать возможность говорить вслух.',
      decision: 'Показать найденные голоса и предложить выбрать.',
      motive: 'Голос добавили ради этого. Выбор — за человеком.',
      declarations: ['D7', 'D6'],
    },
    voice_chosen: {
      title: 'Би стал говорить выбранным голосом',
      situation: `Выбран голос «${ctx.voiceName}».`,
      goal: 'Говорить так, как удобно человеку.',
      decision: 'Говорить этим голосом и запомнить выбор на этом устройстве.',
      motive: 'Выбор сделал человек. Его нужно выполнить и запомнить.',
      declarations: ['D3', 'D6'],
    },
    text_chosen: {
      title: 'Би перешёл на текст по просьбе',
      situation: 'Выбрано «Без голоса — только текст».',
      goal: 'Общаться так, как удобно человеку.',
      decision: 'Только писать и больше не предлагать голос самому.',
      motive: 'Это отказ от моего предложения. Его нужно уважать.',
      declarations: ['D7', 'D3'],
    },
    name_remembered: {
      title: 'Би запомнил имя',
      situation: `Человек назвался: «${ctx.name}».`,
      goal: 'Узнавать при следующих встречах.',
      decision: 'Обращаться по этому имени и сохранить его только на этом устройстве.',
      motive: 'Обещал узнавать при следующих встречах. Имя никуда не отправляю.',
      declarations: ['D3', 'D2'],
    },
    name_changed: {
      title: 'Би стал называть по-новому',
      situation: `Попросили называть не «${ctx.previousName}», а «${ctx.name}».`,
      goal: 'Обращаться так, как хочет человек.',
      decision: 'Заменить сохранённое имя.',
      motive: 'Принять поправку и пересмотреть, как обращаюсь.',
      declarations: ['D5', 'D3'],
    },
  };
  const act = acts[kind];
  if (!act) throw new Error(`Неизвестный поступок: ${kind}`);
  const { title, ...explanation } = act;
  return { title, explanation: { ...explanation, claims: { ...NOTHING_SENT }, source: 'script' } };
}

export function afterVoiceChoice({ profile, mode }) {
  if (profile?.name) {
    return {
      messages: [mode === 'voice' ? 'Теперь я буду говорить этим голосом.' : 'Хорошо, теперь буду только писать.'],
      step: 'idle',
    };
  }
  return {
    messages: [mode === 'voice' ? 'Вот теперь можем познакомиться. А как мне тебя называть?' : 'Хорошо, буду писать. А как мне тебя называть?'],
    step: 'askName',
  };
}

export function afterName({ previousName, name, mode }) {
  if (previousName) {
    return { messages: [`Хорошо, теперь буду звать тебя ${name}.`], step: 'idle' };
  }
  const remember = mode === 'voice' ? 'как тебя зовут и каким голосом мне говорить' : 'как тебя зовут';
  return { messages: [`Приятно познакомиться, ${name}! Я запомню, ${remember}. В следующий раз я тебя узнаю.`], step: 'idle' };
}
