import type { Vote } from "./auction-data";

export interface VoteTransition {
  listingId: string;
  previousVote: Vote;
  nextVote: Exclude<Vote, null>;
}

/** Records only actual state transitions; reaffirming the same vote is not undoable work. */
export function recordVoteTransition(
  history: readonly VoteTransition[],
  transition: VoteTransition,
): VoteTransition[] {
  if (transition.previousVote === transition.nextVote) return [...history];
  return [...history, transition];
}

export function latestVoteTransition(
  history: readonly VoteTransition[],
): VoteTransition | null {
  return history.at(-1) ?? null;
}

export interface PreparedVoteUndo {
  history: VoteTransition[];
  transition: VoteTransition | null;
  staleCount: number;
}

/**
 * Drops stale entries from the top of the stack until the recorded resulting
 * vote still matches current data. This keeps older, valid undo work reachable
 * after a dashboard refresh removes a listing or changes its vote elsewhere.
 */
export function prepareVoteUndo(
  history: readonly VoteTransition[],
  currentVotes: ReadonlyMap<string, Vote>,
): PreparedVoteUndo {
  let latestIndex = history.length - 1;
  while (latestIndex >= 0) {
    const transition = history[latestIndex]!;
    if (currentVotes.get(transition.listingId) === transition.nextVote) {
      return {
        history: history.slice(0, latestIndex + 1),
        transition,
        staleCount: history.length - latestIndex - 1,
      };
    }
    latestIndex -= 1;
  }

  return {
    history: [],
    transition: null,
    staleCount: history.length,
  };
}

/** Removes an undo item only when it is still the latest completed transition. */
export function completeVoteUndo(
  history: readonly VoteTransition[],
  transition: VoteTransition,
): VoteTransition[] {
  if (history.at(-1) !== transition) return [...history];
  return history.slice(0, -1);
}
