import { watchdogBySlug } from '../agents/roster';
import { currentRouting, lateRoute } from '../delivery/nudge';
import { currentTurn } from '../delivery/turns';
import { closeUpdate, currentFeed, backlogBatch, setFeed } from '../feed/feed';
import { changeSubagentFeed, closeSubagentUpdate, watchedSubagent, watchedSubagents } from '../subagents/watch';
import { dropBacklog, waitingUpdates } from './backlog';
import { cadenceOf, countBoundary, setCadence } from './cadence';
import { slotOf } from './slots';
import type { Watchdog } from '../agents/roster';
import type { Routing } from '../delivery/nudge';
import type { Batch, Feed, UpdateClose } from '../feed/feed';
import type { WatchedSubagent } from '../subagents/watch';
import type { Start } from './slots';

// §7.5, §11.2: a backlog a watchdog may review: the primary agent's (no subagent) or a watched subagent's.
export type Backlog = { readonly subagent: WatchedSubagent | undefined; readonly batch: Batch };

// §7.5, §11.2: the feed of each watched agent, which holds a backlog for each of its watchdogs: the primary
// agent's (no subagent), then each watched subagent's.
export const watchedFeeds = (): { readonly subagent: WatchedSubagent | undefined; readonly feed: Feed }[] => [
  { subagent: undefined, feed: currentFeed() },
  ...watchedSubagents().map((watch) => ({ subagent: watch, feed: watch.feed })),
];

// §7.4, §11.2: the cadence of one pair of a watchdog and a watched agent; the primary agent's pair is the slug.
export const cadenceKey = (slug: string, subagent: string | undefined): string =>
  subagent === undefined ? slug : `${slug}@${subagent}`;

// §7.4: a review of `slug` on the watched agent `subagent` started, so its cadence there is due no more.
export const clearDue = (slug: string, subagent: string | undefined): void => {
  const pair = cadenceKey(slug, subagent);
  setCadence(pair, { ...cadenceOf(pair), isDue: false });
};

// §7.4: each watchdog of the watched agent `agentId` counts its boundary by its cadence.
export const countBoundaries = (
  agentId: string | undefined,
  watchers: readonly Watchdog[],
  isTurnEnd: boolean
): void => {
  watchers.forEach((watchdog) => {
    const pair = cadenceKey(watchdog.slug, agentId);
    setCadence(pair, countBoundary(cadenceOf(pair), watchdog, isTurnEnd));
  });
};

// §7.5: the order in which the updates closed across all watched agents (the last row of an update → its
// rank), so that a free watchdog takes the backlog whose oldest update waits longest.
const order = { next: 1, ranks: new Map<string, number>() };

const rankLast = (feed: Feed | undefined): void => {
  const end = feed?.ends.at(-1)?.uuid;
  if (end !== undefined && !order.ranks.has(end)) {
    order.ranks.set(end, order.next);
    order.next += 1;
  }
};

// §7.2, §11.2: the watchdogs that a boundary of this loop counts for: the roster for the primary agent, the
// listed ones for a watched subagent; undefined for any other loop.
export const watchersOf = (
  agentId: string | undefined,
  roster: readonly Watchdog[]
): readonly Watchdog[] | undefined => {
  const watch = watchedSubagent(agentId);
  if (agentId === undefined || watch === undefined) {
    return agentId === undefined ? roster : undefined;
  }
  return roster.filter((watchdog) => watch.watchdogs.includes(watchdog.slug));
};

// §7.2, §11.2: a boundary closes the update of its watched agent; §10.8: at the main-loop turn counter of now.
export const closeBacklog = (agentId: string | undefined, close: UpdateClose): void => {
  if (agentId === undefined) {
    setFeed(closeUpdate(currentFeed(), close, currentTurn()));
  }
  rankLast(agentId === undefined ? currentFeed() : closeSubagentUpdate(agentId, close, currentTurn()));
};

const rankOf = (backlog: Backlog): number => order.ranks.get(backlog.batch.updates[0]?.rows.at(-1)?.uuid ?? '') ?? 0;

// §7.4, §10.3, §10.4: `skipWhenNoNudge` leaves the due review of an `agent-end` watchdog on the primary agent's
// backlog while the session is idle and a late concern would not nudge (Esc, the concern budget spent, the cooldown):
// its notes would wait for the next person prompt. The review stays due and starts at the next boundary. §10.6: a
// headless session has no nudge, so the option does nothing there. The rule is a build-session choice on those §§.
export const isSkippedForNoNudge = (
  watchdog: Pick<Watchdog, 'reviewMode' | 'isSkippedWhenNoNudge'>,
  subagent: string | undefined,
  routing: Routing
): boolean =>
  watchdog.reviewMode === 'agent-end' &&
  watchdog.isSkippedWhenNoNudge &&
  subagent === undefined &&
  !routing.isHeadless &&
  !routing.isTurnRunning &&
  lateRoute('concern', routing) !== 'nudge pending';

const isSkippedNow = (slug: string, subagent: string | undefined): boolean => {
  const watchdog = watchdogBySlug(slug);
  return watchdog !== undefined && isSkippedForNoNudge(watchdog, subagent, currentRouting());
};

// How a review takes a backlog: as `start` says (§7.4, §12.3), and whether it starts at a turn end: the end of a main
// turn, or after another review while no main turn runs. `start` alone goes to the slot.
export type Take = { readonly start: Start; readonly isTurnEnd: boolean };

// §7.4, §12.3: whether a review that starts this way takes from this backlog: a boundary review a due one, a try
// any one, the compact retry only the backlog of the review it repeats. A review at a turn end skips a due backlog
// that `skipWhenNoNudge` leaves.
const isTaken = (slug: string, subagent: string | undefined, { start, isTurnEnd }: Take): boolean => {
  if (start.isCompact === true) {
    return subagent === start.subagent;
  }
  if (start.from !== undefined) {
    return true;
  }
  return cadenceOf(cadenceKey(slug, subagent)).isDue && !(isTurnEnd && isSkippedNow(slug, subagent));
};

// §7.5: a free watchdog takes the backlog with the oldest update that waits, of the ones it may take now; the
// primary agent's on a tie.
export const takeBacklog = (slug: string, take: Take): Backlog | undefined => {
  const sources = watchedFeeds().filter(({ subagent }) => subagent === undefined || subagent.watchdogs.includes(slug));
  const backlogs = sources.flatMap(({ subagent, feed }) => {
    const batch = isTaken(slug, subagent?.agentId, take) ? backlogBatch(feed, slug) : undefined;
    return batch === undefined ? [] : [{ subagent, batch }];
  });
  return backlogs.reduce<Backlog | undefined>(
    (oldest, backlog) => (oldest === undefined || rankOf(backlog) < rankOf(oldest) ? backlog : oldest),
    undefined
  );
};

// §7.1, §7.5, §12.3: the outcome of a review changes the backlog it took: the primary agent's feed or a watched
// subagent's. The ranks of the updates that left every feed go too.
export const changeBacklog = (subagent: string | undefined, change: (feed: Feed) => Feed): void => {
  if (subagent === undefined) {
    setFeed(change(currentFeed()));
  } else {
    changeSubagentFeed(subagent, change);
  }
  const live = new Set(watchedFeeds().flatMap(({ feed }) => feed.ends.map((close) => close.uuid)));
  [...order.ranks.keys()].filter((uuid) => !live.has(uuid)).forEach((uuid) => order.ranks.delete(uuid));
};

// §7.5, §10.6: the backlog of `slug` on the watched agent `subagent` (none for the primary agent) goes. Returns how
// many updates it held.
export const dropUnboundBacklog = (subagent: string | undefined, slug: string): number => {
  const feed = watchedFeeds().find((watched) => watched.subagent?.agentId === subagent)?.feed;
  const updates = feed === undefined ? 0 : waitingUpdates(feed, feed.cursors[slug]);
  changeBacklog(subagent, (backlog) => dropBacklog(backlog, slug));
  return updates;
};

// §10.8: whether a review of the watchdog `slug` runs now (on any watched agent, §7.5), or is due on the watched agent
// `subagent` (none for the primary agent): the watchdog is idle, and its cadence there is due with a backlog (§7.4)
// that `skipWhenNoNudge` does not leave.
export const isReviewComing = (slug: string, subagent: string | undefined): boolean => {
  const slot = slotOf(slug);
  const feed = watchedFeeds().find((watched) => watched.subagent?.agentId === subagent)?.feed;
  const isDue =
    slot.state === 'idle' &&
    cadenceOf(cadenceKey(slug, subagent)).isDue &&
    feed !== undefined &&
    backlogBatch(feed, slug) !== undefined &&
    !isSkippedNow(slug, subagent);
  return slot.state === 'reviewing' || isDue;
};
