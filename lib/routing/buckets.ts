import type { DriveBucket } from "./types";

export const TWO_HOURS_SECONDS = 2 * 60 * 60;
export const FOUR_HOURS_SECONDS = 4 * 60 * 60;
export const EIGHT_HOURS_SECONDS = 8 * 60 * 60;
export const LOCAL_PROXIMITY_ROAD_FACTOR = 1.2;
export const LOCAL_PROXIMITY_AVERAGE_SPEED_MPH = 50;

/**
 * A route beyond this direct-radius lower bound cannot satisfy the active
 * eight-hour local-proximity contract under its road-factor estimate.
 */
export const OPERATIONAL_DIRECT_RADIUS_CEILING_MILES =
  EIGHT_HOURS_SECONDS / 60 / 60 * LOCAL_PROXIMITY_AVERAGE_SPEED_MPH /
  LOCAL_PROXIMITY_ROAD_FACTOR;

/** Unknown, negative, and non-finite estimated durations are hard-excluded. */
export function driveBucketForSeconds(
  driveSeconds: number | null | undefined,
): DriveBucket {
  if (
    driveSeconds === null ||
    driveSeconds === undefined ||
    !Number.isFinite(driveSeconds) ||
    driveSeconds < 0
  ) {
    return "exclude";
  }
  if (driveSeconds <= TWO_HOURS_SECONDS) return "under_2h";
  if (driveSeconds <= FOUR_HOURS_SECONDS) return "under_4h";
  if (driveSeconds <= EIGHT_HOURS_SECONDS) return "under_8h";
  return "exclude";
}
