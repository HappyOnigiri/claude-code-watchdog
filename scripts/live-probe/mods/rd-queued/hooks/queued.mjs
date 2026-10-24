// Release-probe mod (spec §7.4 agent-end and queued prompts): logs what the observer leaves out of the main loop's
// events: a `prompt.submit`'s `turnId` and `wait`, and a `session.append` row's `name`, with each turn's start and end.
const FILE = '__LOG__/rd-queued.jsonl';
const lines = [];
let writing = null;
let isDirty = false;

// Rewrites the whole log file; a write asked while one runs is folded into one more pass (as the observer does).
const flush = ($) => {
  if (writing) {
    isDirty = true;
    return writing;
  }
  writing = (async () => {
    do {
      isDirty = false;
      await $.fs.write(FILE, `${lines.join('\n')}\n`);
    } while (isDirty);
  })()
    .catch(() => undefined)
    .finally(() => {
      writing = null;
    });
  return writing;
};

const record = ($, data) => {
  lines.push(JSON.stringify({ t: Date.now(), ...data }));
  return flush($);
};

const textOf = (content) =>
  (Array.isArray(content) ? content : [])
    .map((block) => (block?.type === 'text' ? block.text : `[${block?.type}]`))
    .join('\n')
    .slice(0, 2000);

export const register = (on) => {
  on('prompt.submit', async ($, e, next) => {
    await record($, {
      kind: 'submit',
      text: String(e.text ?? '').slice(0, 300),
      turnId: e.turnId ?? null,
      wait: e.wait ?? null,
      origin: e.origin?.kind ?? null,
    });
    return next(e);
  });
  on('turn.start', async ($, e, next) => {
    if (!e.agentId) {
      await record($, { kind: 'start', turnId: e.turnId, text: String(e.text ?? '').slice(0, 300) });
    }
    return next(e);
  });
  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) {
      await record($, {
        kind: 'complete',
        turnId: e.turnId,
        isAborted: e.isAborted,
        answer: String(e.answer ?? '').slice(0, 300),
      });
    }
    return next(e);
  });
  on('session.append', async ($, e, next) => {
    if (!e.agentId) {
      const message = e.message ?? {};
      await record($, {
        kind: 'append',
        door: e.door ?? null,
        type: message.type ?? null,
        name: message.name ?? null,
        origin: e.origin?.kind ?? null,
        text: textOf(message.content),
      });
    }
    return next(e);
  });
};
