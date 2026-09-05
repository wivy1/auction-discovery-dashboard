/** This distribution does not activate a trained preference estimator. */
export const ACTIVE_PREFERENCE_V2_MODEL_VERSION: string | null = null;
export const ACTIVE_PREFERENCE_V2_FEATURE_VERSION = "preference-v2-features-v2" as const;
export const PREFERENCE_V2_RUNTIME_NO_BASELINE_MODEL_VERSION = "preference-v2-runtime-no-baseline-v1" as const;
export const PREFERENCE_V2_RUNTIME_NO_BASELINE_FEATURE_VERSION = "preference-v2-runtime-unrated-sentinel-v1" as const;
export { PREFERENCE_V2_RUNTIME_IDENTITY_VERSIONS } from "./runtime-identity";
