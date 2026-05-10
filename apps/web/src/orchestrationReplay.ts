import type {
  OrchestrationEvent,
  OrchestrationReplayEventsInput,
  OrchestrationReplayEventsResult,
} from "@t3tools/contracts";

export interface OrchestrationReplayApi {
  replayEvents: (input: OrchestrationReplayEventsInput) => Promise<OrchestrationReplayEventsResult>;
}

export async function replayAllOrchestrationEvents(
  api: OrchestrationReplayApi,
  input: { fromSequenceExclusive: number },
): Promise<ReadonlyArray<OrchestrationEvent>> {
  const events: OrchestrationEvent[] = [];
  await replayOrchestrationEventPages(api, input, (pageEvents) => {
    events.push(...pageEvents);
  });
  return events;
}

export async function replayOrchestrationEventPages(
  api: OrchestrationReplayApi,
  input: { fromSequenceExclusive: number },
  applyPage: (events: ReadonlyArray<OrchestrationEvent>) => void | Promise<void>,
): Promise<number> {
  let fromSequenceExclusive = input.fromSequenceExclusive;

  for (;;) {
    const page = await api.replayEvents({ fromSequenceExclusive });
    await applyPage(page.events);
    if (!page.hasMore) {
      return page.nextSequence;
    }
    if (page.nextSequence <= fromSequenceExclusive) {
      throw new Error("Replay cursor did not advance.");
    }
    fromSequenceExclusive = page.nextSequence;
  }
}
