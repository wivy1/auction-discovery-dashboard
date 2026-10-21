import type { AcquiredSourcePage } from "../../lib/sources/acquired-pages.ts";

export class BrowserCleanupError extends Error {}
export async function captureGenericSourcePages(): Promise<readonly AcquiredSourcePage[]> {
  const state = (globalThis as unknown as {
    __publicSourceCallbackFixture: { pages: readonly AcquiredSourcePage[]; captureCalls: number };
  }).__publicSourceCallbackFixture;
  state.captureCalls += 1;
  return state.pages;
}
