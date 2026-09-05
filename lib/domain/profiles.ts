import type { BinaryVote } from "./votes";

export interface ProfileConcept {
  readonly label: string;
  readonly confidence: number;
  readonly supportCount: number;
  readonly representativeListingIds: readonly string[];
}

export interface InterestProfileVersion {
  readonly id: string;
  readonly profileId: string;
  readonly version: number;
  readonly algorithmVersion: string;
  readonly humanSummary: string;
  readonly interestedConcepts: readonly ProfileConcept[];
  readonly notInterestedConcepts: readonly ProfileConcept[];
  readonly interestedSupportCount: number;
  readonly notInterestedSupportCount: number;
  readonly basedOnVotesThrough: string | null;
  readonly createdAt: string;
}

export interface ProfileTrainingLabel {
  readonly listingId: string;
  readonly vote: BinaryVote;
}

