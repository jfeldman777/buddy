// Scripted acquaintance with Bi. Pure functions without DOM, so the flow is testable in Node.
// Bi addresses the person as «ты»; Bi himself is masculine. Lines avoid gendered verbs about the person.

export const MAX_NAME_LENGTH = 40;

export const VOICE_SAMPLE = 'Привет! Я Би. Буду говорить так.';

export const prompts = {
  changeVoice: 'Выбери, каким голосом мне говорить.',
  changeName: 'Как мне тебя называть?',
  noVoicesHere: 'На этом устройстве нет русского голоса, так что я могу только писать.',
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
// step: 'chooseVoice' | 'askName' | 'idle'; mode: 'voice' | 'text' | null (not chosen yet).
export function opening({ profile, speechSupported, voices }) {
  const name = profile?.name;
  const canSpeak = speechSupported && voices.length > 0;

  if (!name) {
    if (profile?.mode) {
      return { messages: ['Привет ещё раз! Мы не договорили. Как мне тебя называть?'], step: 'askName', mode: profile.mode };
    }
    if (!speechSupported) {
      return {
        messages: ['Привет! Я Би. На этом устройстве я не могу говорить вслух, так что будем переписываться. А как мне тебя называть?'],
        step: 'askName',
        mode: 'text',
      };
    }
    if (!canSpeak) {
      return {
        messages: ['Привет! Я Би. На этом устройстве нет русского голоса, так что пока будем переписываться. А как мне тебя называть?'],
        step: 'askName',
        mode: 'text',
      };
    }
    return { messages: ['Привет! Я Би. Сначала выбери, каким голосом мне говорить.'], step: 'chooseVoice', mode: null };
  }

  if (profile.mode === 'voice' && !findVoice(voices, profile.voice)) {
    if (!canSpeak) {
      return { messages: [`Привет, ${name}! Рад снова тебя видеть. Голоса, которым я говорил, здесь нет, так что пока буду писать.`], step: 'idle', mode: 'text' };
    }
    return { messages: [`Привет, ${name}! Рад снова тебя видеть. Голоса, которым я говорил, здесь нет. Выбери другой.`], step: 'chooseVoice', mode: null };
  }

  return { messages: [`Привет, ${name}! Рад снова тебя видеть.`], step: 'idle', mode: profile.mode ?? 'text' };
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
