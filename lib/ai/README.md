Optional text enrichment
========================

The public distribution starts with enrichment disabled. Reading configuration,
rendering listings, and recording ordinary votes do not require an AI service.
Set all four environment values to opt into the existing enrichment pipeline:

- `AI_TEXT_PROVIDER`
- `AI_TEXT_MODEL`
- `AI_EMBEDDING_PROVIDER`
- `AI_EMBEDDING_MODEL`

The installed provider implementation is `ollama`. Models must already be
installed; configuration does not download them. The embedding model must have
a known dimension contract in `lib/enrichment/target.ts`. The provider interfaces
in `types.ts` and the factory in `factory.ts` are the integration points for a
different local provider or embedding dimension contract.

`optionalAiCapabilities()` reads configuration only. A complete configuration
enables automatic enrichment work; provider readiness is checked when an explicit
enrichment session runs. Inactive providers expose stable provenance
`enrichment-unconfigured-v1`, with zero embedding dimensions to describe the
absence of a vector. Inference methods reject inactive configuration before
contacting a provider. Never persist an embedding using the inactive target.

Text enrichment does not install or activate a preference estimator. This
distribution has no bundled trained preference model, training corpus, or
turnkey preference-training/activation workflow. Listings remain Unrated. The
data-free ranking library is retained for development, but the application does
not rebuild a profile or present its neutral scores as learned recommendations.
