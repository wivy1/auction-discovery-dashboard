import type { PreferenceAdapter } from "./lib/preferences/starter";

// Copy to preference-adapter.local.ts and implement the hooks for your own model.
// No model, fitted estimator, training records, downloads, or runtime changes are included.
// Local paths are relative to context.projectRoot; validate model format and feature
// compatibility before loading weights. Never treat a selected filename as activation.
const adapter: PreferenceAdapter = {
  schemaVersion: 1,

  async train(_context) {
    void _context;
    throw new Error(
      "Preference training is not implemented. Implement train() in preference-adapter.local.ts " +
      "to train and evaluate your own model, save its artifact, and return its manifest with " +
      "the actual artifact digest and context.snapshotSha256. No estimator is bundled.",
    );
  },

  async generateProfile(_context) {
    void _context;
    throw new Error(
      "Profile generation is not implemented. Implement generateProfile() in preference-adapter.local.ts " +
      "to summarize context.snapshot using your selected model or your own deterministic method. " +
      "Return the model identity, context.snapshotSha256, and signals supported by the supplied " +
      "listing IDs and their votes; honor signalCorrections. Do not invent evidence.",
    );
  },

  async activate(_context) {
    void _context;
    throw new Error(
      "Preference activation is not implemented. Implement activate() and readActiveModel() " +
      "in preference-adapter.local.ts with a real compatible runtime bridge. A manifest alone " +
      "does not enable dashboard scores or automatic learning. Do not change the " +
      "legacy Preference V2 constant to bypass the missing integration.",
    );
  },

  async readActiveModel(_context) {
    void _context;
    // Replace with a read of the identity actually loaded by your runtime bridge.
    return null;
  },

  async score(_context) {
    void _context;
    // This hook is for your runtime bridge. The starter CLI does not invoke it.
    // Return each successful input listing ID once, a finite score from 0 to 100,
    // and a nonempty explanation supported by that listing and your learned evidence.
    // Omit unsupported/failed rows so the bridge keeps them Unrated. Never substitute
    // a neutral or invented numeric score, and never return IDs outside the input.
    throw new Error(
      "Preference scoring is not implemented. Implement score() in preference-adapter.local.ts " +
      "using your compatible model and connect its validated results to your runtime bridge. " +
      "The starter does not publish scores to the dashboard.",
    );
  },
};

export default adapter;
