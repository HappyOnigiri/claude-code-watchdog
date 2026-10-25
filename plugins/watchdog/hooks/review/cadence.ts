import { isTurnFollowed } from '../feed/queue';
import type { Watchdog } from '../agents/roster';
import type { UpdateClose } from '../feed/feed';

// §7.4: the eligible updates a watchdog has seen since `/watchdog on`, and whether a review is due. Updates
// that the interval skips wait in the backlog and go with the next review (§7.5).
export type Cadence = { readonly eligible: number; readonly isDue: boolean };

export const NO_BOUNDARY: Cadence = { eligible: 0, isDue: false };

// §7.4: `turn` counts each boundary, `agent-end` only the end of a turn; every Nth eligible update makes a
// review due. A due review that has not run stays due.
export const countBoundary = (
  cadence: Cadence,
  watchdog: Pick<Watchdog, 'reviewMode' | 'reviewInterval'>,
  isTurnEnd: boolean
): Cadence => {
  if (watchdog.reviewMode === 'agent-end' && !isTurnEnd) {
    return cadence;
  }
  const eligible = cadence.eligible + 1;
  return { eligible, isDue: cadence.isDue || eligible % watchdog.reviewInterval === 0 };
};

// The cadence of each watchdog slug, in module memory; `/watchdog on` starts it again.
const cadences = new Map<string, Cadence>();

// §7.4: whether the primary agent owes `agent-end` the end of a turn that a queued prompt followed. Kept as the
// cadences are: a hot reload drops it, `/watchdog on` resets it.
const owed = { isTurnEnd: false };

export const cadenceOf = (slug: string): Cadence => cadences.get(slug) ?? NO_BOUNDARY;

export const setCadence = (slug: string, cadence: Cadence): void => {
  cadences.set(slug, cadence);
};

export const resetCadences = (): void => {
  cadences.clear();
  owed.isTurnEnd = false;
};

// §7.4: whether a boundary ends the turn of its agent. A main turn that a queued person prompt follows does not
// (an Esc too): the turns of the queue count once for `agent-end`, at the end of the last one.
export const isTurnEndOf = (agentId: string | undefined, close: UpdateClose, turnId: string): boolean => {
  if (close === 'step' || agentId !== undefined) {
    return close !== 'step';
  }
  owed.isTurnEnd = isTurnFollowed(turnId);
  return !owed.isTurnEnd;
};

// §7.4: a person prompt into an idle session, while the primary agent owes a turn end: the queued turn never came
// (a prompt taken back from the queue), so the end counts now for each `agent-end` watchdog. Returns whether it did.
export const payOwedTurnEnd = (watchdogs: readonly Watchdog[]): boolean => {
  if (!owed.isTurnEnd) {
    return false;
  }
  owed.isTurnEnd = false;
  watchdogs
    .filter((watchdog) => watchdog.reviewMode === 'agent-end')
    .forEach((watchdog) => {
      setCadence(watchdog.slug, countBoundary(cadenceOf(watchdog.slug), watchdog, true));
    });
  return true;
};
