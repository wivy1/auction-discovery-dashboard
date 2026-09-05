import type {
  SchedulerCandidate,
  SchedulerHandler,
  SchedulerHandlerRegistry,
} from "./types";

export function schedulerHandlerKey(candidate: Pick<
  SchedulerCandidate,
  "kind" | "sourceId" | "stage"
>): string {
  return candidate.kind === "source_acquisition"
    ? `source:${candidate.sourceId}`
    : `preparation:${candidate.sourceId}:${candidate.stage}`;
}

export function createSchedulerHandlerRegistry(
  handlers: readonly SchedulerHandler[],
): SchedulerHandlerRegistry {
  const entries = new Map<string, SchedulerHandler>();
  for (const handler of handlers) {
    if (entries.has(handler.id)) {
      throw new Error(`duplicate scheduler handler ${handler.id}`);
    }
    entries.set(handler.id, handler);
  }
  return Object.freeze({
    handlers: entries,
    resolve(candidate: SchedulerCandidate): SchedulerHandler | null {
      return entries.get(schedulerHandlerKey(candidate)) ?? null;
    },
  });
}

export function unavailableSchedulerHandler(input: {
  readonly id: string;
  readonly reasonCode: string;
}): SchedulerHandler {
  const fail = (): never => {
    throw new Error(`scheduler handler ${input.id} is not ready: ${input.reasonCode}`);
  };
  return Object.freeze({
    id: input.id,
    ready: false,
    readinessReasonCode: input.reasonCode,
    reserve: async () => fail(),
    acquire: async () => fail(),
    validate: async () => fail(),
    commit: async () => fail(),
  });
}
