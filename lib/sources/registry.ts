import localSources from "../../source-adapters.local";
export type { SourceRegistration } from "./registration";
import { validateSourceRegistrations, type SourceRegistration } from "./registration";
import type { SourceAdapter, SourceId, SourceManifest } from "./types";

export const sourceRegistrations = validateSourceRegistrations(localSources);
const registrationsById = new Map(sourceRegistrations.map((registration) =>
  [registration.adapter.manifest.id, registration],
));

export const sourceRegistry: ReadonlyMap<SourceId, SourceAdapter> = new Map(
  sourceRegistrations.map(({ adapter }) => [adapter.manifest.id, adapter]),
);

export function getSourceAdapter(sourceId: SourceId): SourceAdapter {
  const adapter = sourceRegistry.get(sourceId);
  if (!adapter) throw new Error(`Unknown auction source: ${sourceId}.`);
  return adapter;
}

export function findSourceAdapter(sourceId: string): SourceAdapter | undefined {
  return sourceRegistry.get(sourceId);
}

export function findSourceRegistration(sourceId: string): SourceRegistration | undefined {
  return registrationsById.get(sourceId);
}

export function listSourceManifests(): readonly SourceManifest[] {
  return sourceRegistrations.map(({ adapter }) => adapter.manifest);
}
