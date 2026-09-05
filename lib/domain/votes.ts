import { DomainValidationError } from "./errors";

export const binaryVotes = ["interested", "not_interested"] as const;
export type BinaryVote = (typeof binaryVotes)[number];

export function isBinaryVote(value: unknown): value is BinaryVote {
  return value === "interested" || value === "not_interested";
}

export function parseBinaryVote(value: unknown): BinaryVote {
  if (!isBinaryVote(value)) {
    throw new DomainValidationError(
      "vote must be exactly 'interested' or 'not_interested'",
      "vote",
    );
  }
  return value;
}

