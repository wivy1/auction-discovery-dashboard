# Preference training and model integration starter

This is a developer starter for bringing your own preference model. It provides local file contracts, typed hooks, and explicit commands for training, profile generation, and activation. It does **not** supply a trained model, a trainer, a working scorer, a dashboard publisher, or automatic retraining. A fresh installation remains **Unrated**.

The commands manage files and call code that you implement in an ignored local adapter. The example hooks stop with `not implemented` errors. No model is downloaded, no training begins during setup or voting, and no starter command directly writes the application database.

## Files and initialization

Run normal repository setup first, then:

```powershell
pnpm preference init
```

This creates the following local structure and preserves existing files:

```text
preference-adapter.local.ts          # Your trainer, scorer, profile, and runtime hooks
preference.config.local.json         # Paths to your local inputs and outputs
preferences.local/
  training-data.json                 # Empty snapshot; fill with your own reviewed records
  model-manifest.json                # Intentionally incomplete model placeholder
  profile.json                       # Created only after your profile hook succeeds
models.local/                        # Your downloaded or trained model artifacts
```

These paths are ignored by Git. Keep private data, evaluation reports, and generated files under `preferences.local/`, and model artifacts under `models.local/`. Keep an existing installation's local files when updating the repository. A model artifact may be a single file or an archive that your adapter knows how to load; the starter hashes that file without deserializing it.

The public templates are [`preference.config.example.json`](../preference.config.example.json), [`preference-adapter.example.ts`](../preference-adapter.example.ts), and [`examples/preferences`](../examples/preferences). The training example is invented format documentation; `init` creates an empty snapshot and does not import those example records. The placeholder model manifest deliberately fails validation until you replace its fields.

## 1. Prepare your own review snapshot

Configure authorized sources and review listings in the application. Then implement a read-only export of your own stored records into `preferences.local/training-data.json`, following [`TrainingSnapshot`](../lib/preferences/starter.ts) and the [JSON format example](../examples/preferences/training-data.example.json). This starter does not include an automatic database exporter.

Use stable listing IDs, retained source titles/descriptions, and the current Interested or Not interested vote for each listing. `listing_votes`, `listing_stubs`, `listing_details`, and `profile_signal_feedback` in [`db/schema.ts`](../db/schema.ts) describe the stored inputs. Include historical reviewed listings when appropriate; source expiry does not erase a vote. Exclude undone/unvoted records and resolve repeated votes to one current value per listing. Do not refetch immutable details for training or replace source text with generated claims.

`signalCorrections` contains removed/restored concepts in chronological order. Removal is a neutral constraint for the same polarity, not an opposite vote. Preserve that meaning in training, scoring, and profiles. The profile validator rejects an exact removed signal and checks that supporting IDs carry the corresponding vote; semantic correctness beyond those checks belongs to your implementation.

Training needs both vote classes. The CLI checks that each exists, but two example rows are not evidence of a useful dataset. You choose adequate data, a reproducible feature contract, and an evaluation method that keeps duplicate or related listings from leaking between training and evaluation. Freeze the snapshot while a command runs. Its SHA-256 identifies the exact file bytes, including whitespace and encoding; regenerate dependent artifacts after changing the snapshot.

## 2. Supply a compatible model

Choose one of these paths:

- **Train your own:** implement `train()` in `preference-adapter.local.ts`, then run `pnpm preference train`. The hook should train and evaluate your chosen estimator, save a versioned artifact inside `models.local/`, and return a `ModelManifest`. The CLI verifies the artifact digest and exact snapshot digest before saving the candidate manifest. Training does not activate it.
- **Use a downloaded model:** obtain an artifact and its loader/feature specification from its publisher, place the artifact in `models.local/`, and fill in `preferences.local/model-manifest.json`. You still need to implement the scoring, profile, and activation hooks for that format. There is no universal preference-model download for this app.

An Ollama text or embedding model alone is not a trained preference estimator. Optional text enrichment is configured separately in `.env.local`. A model trained for another feature set or another person's labels is not automatically compatible with this workflow.

The manifest records the model ID, model version, feature version, local artifact path, artifact SHA-256, creation time, and training snapshot SHA-256. Use `null` for the training snapshot digest only when importing a model without a known local training snapshot. Your loader must validate the model format, preprocessing/tokenization, dimensions, and feature version; the starter's string and digest checks do not establish those properties.

To compute the downloaded artifact's digest:

```powershell
(Get-FileHash -Algorithm SHA256 .\models.local\your-model-file).Hash.ToLowerInvariant()
```

Replace all manifest placeholders with actual values and run:

```powershell
pnpm preference check
```

`check` reads the snapshot and artifact, verifies their file contracts and artifact digest, and imports the adapter to check hook signatures. It does not run the hooks, evaluate the model, establish feature compatibility, or prove application integration. Keep model loading and side effects inside explicit hooks, not at module import time.

## 3. Implement scoring and profile generation

Implement `score()` for your runtime bridge. Return a finite score from 0 through 100 and an evidence-based explanation for each successfully scored input ID. The bridge must validate results against the input batch and model identity and leave unsupported or failed listings Unrated. The standalone CLI does not call this hook or publish scores.

Implement `generateProfile()` to return a `ProfileArtifact`: model identity, exact snapshot digest, generation timestamp, summary, and positive/negative signals with supporting listing IDs. You may use your own deterministic method or an explicitly configured local text model. A generated summary must stay grounded in the supplied evidence.

```powershell
pnpm preference profile
```

The CLI validates model identity, snapshot identity, signal polarity, supporting IDs, and explicit signal removals, then writes `preferences.local/profile.json`. For a locally trained candidate, the snapshot must match the training snapshot in its manifest. The saved JSON is an interchange artifact; it does not populate the dashboard's profile tables by itself.

The existing pure helpers in [`lib/ranking/profile.ts`](../lib/ranking/profile.ts) and [`profile-narrative.ts`](../lib/ranking/profile-narrative.ts) can inform your implementation. They are development primitives, including a centroid baseline; they are not the omitted trained estimator and are not enabled by the starter. Do not turn insufficient-evidence baseline scores into a claim of learned recommendations.

## 4. Implement activation and connect the application

Implement `activate()` to load the candidate into your actual scoring integration, after compatibility and evaluation checks. Implement `readActiveModel()` to read back the model ID, version, feature version, and artifact digest that the runtime actually loaded. Returning the requested manifest without loading a scorer is not activation.

```powershell
pnpm preference activate
```

The CLI validates the artifact before calling your hook and compares the runtime identity returned by your adapter afterward. A mismatch fails the command. Your hook owns any runtime side effects and rollback; the CLI cannot undo a partially implemented activation. Preserve the previous working model and provide a disable/rollback path in your integration. Do not overwrite the bytes of an already active artifact when training a new version.

The application bridge remains implementation work. These are the current connection points:

| Area | Current public behavior | Work your integration must supply |
| --- | --- | --- |
| Model identity | [`lib/preference-v2/review-runtime.ts`](../lib/preference-v2/review-runtime.ts) keeps the legacy active model `null` | Load and validate your model with a compatible runtime identity. Editing this constant alone is insufficient. |
| Work scheduling | [`lib/ai/capabilities.ts`](../lib/ai/capabilities.ts) disables preference scoring; the [nightly endpoint](../app/api/internal/nightly-scheduler/route.ts) rejects scoring candidates | Add explicit opt-in execution, readiness/failure handling, and finite work for your scorer. |
| Profile generation | [`lib/pipeline/enrichment-run.ts`](../lib/pipeline/enrichment-run.ts) does not rebuild a profile | Connect an explicit profile publication path and define when it runs. |
| Profile storage | [`lib/pipeline/profile.ts`](../lib/pipeline/profile.ts) contains an unconnected legacy rebuild using D1 and Cloudflare bindings | Use a compatible publisher under the existing mutation lease, with immutable provenance and projection invalidation. Do not invoke this function as a standalone Node writer. |
| Score display | [`db/dashboard.ts`](../db/dashboard.ts) supplies an empty ratings map | Read and validate scores from your integration. Merely inserting `listing_scores` does not enable their display. |
| Profile display | The dashboard reads its existing versioned profile schema | Map and publish your profile artifact to that schema, preserving support and correction history. A JSON file is not that schema. |

Keep exactly one D1/R2 mutation lane. Source acquisition, vote clicks, and ordinary recovery must remain AI-free. Failed model work must preserve original source facts and Unrated review. The starter deliberately makes no edits to those runtime boundaries.

Before calling your completed integration automatic learning, test an actual local cycle: export fresh votes, train/evaluate or load a candidate, generate a profile, activate and read back the exact model, score current listings, see the profile and scores in the dashboard, restart, and disable or roll back. Check undo/changed votes, removed/restored signals, missing models, invalid outputs, and stale artifacts. Only then add opt-in retraining triggers or scheduled learning and test their failure recovery. These tasks are not implemented by the starter.

## Command results and failures

| Command | Successful result |
| --- | --- |
| `pnpm preference init` | Preserved existing local files and created missing placeholders. |
| `pnpm preference check` | Valid file contracts, matching artifact digest, and callable hook signatures. |
| `pnpm preference train` | Saved a validated candidate manifest after your training hook. No activation. |
| `pnpm preference profile` | Saved a validated local profile JSON after your profile hook. No dashboard publication. |
| `pnpm preference activate` | Your adapter reported the requested model identity after its activation hook. Actual UI acceptance is still yours to verify. |

Commands emit progress to stderr, one JSON result to stdout on success, and a nonzero exit code on failure. Generated manifest/profile files are replaced only after validation. Training hooks manage their own intermediate artifacts, resources, cancellation, and checkpoints. No long model training is implemented or tested in this distribution.

Only one starter command runs per local workspace. An interrupted process can leave `preferences.local/workflow.lock`; confirm the command and any model subprocess have stopped before removing that lock. Do not run your runtime-publishing hooks concurrently with another application mutation lane. The CLI lock coordinates starter commands only.
