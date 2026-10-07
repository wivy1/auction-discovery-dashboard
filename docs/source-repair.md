# Local source-adapter repair

This optional after-run workflow uses a downloaded local Ollama text model on your machine to analyze failed discovery and propose supported parser changes. It tests proposals offline; it never applies them automatically or bypasses a site's access controls. You supply the adapters, model and tests.

## Requirements

- A downloaded local Ollama text model. The [listing-enrichment setup](../README.md#listing-enrichment) has examples; no particular model is required or bundled. Cloud-backed aliases are rejected, even through a localhost endpoint.
- Existing WSL with x86_64 Ubuntu and bubblewrap for native validation.
- The pinned portable Linux Node.js 24.18.0 runtime, prepared through optional repair setup.

From the project folder, prepare the offline sandbox explicitly:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\setup-source-repair.ps1
```

This checks existing Ubuntu/bubblewrap and prepares the verified pinned Linux Node runtime. Append `-CheckOnly` to check without downloads or writes, or `-ArchivePath "path/to/node-v24.18.0-linux-x64.tar.xz"` to supply the verified official archive offline. It does not install WSL, Ubuntu, bubblewrap or models. Normal `pnpm setup` does not run this optional setup. Missing dependencies leave repair unavailable; normal discovery can still run.

## Opt in an adapter

Keep repairable adapter modules, helpers and sanitized tests under the ignored `source-adapters.local/` directory, separate from the credential-bearing `source-adapters.local.ts` registry. Each module must export its adapter as `adapter`, for example `export const adapter = ...`. Register your real source normally, then opt it into repair using `source-repair.config.local.json`.

Normal setup creates this configuration with empty `targets` only if absent and preserves existing local files. Empty targets remain inert. An illustrative target is:

```json
{
  "schemaVersion": "source-repair-config-v1",
  "targets": [
    {
      "sourceId": "example_json",
      "adapterPath": "source-adapters.local/example-json/adapter.ts",
      "testFiles": ["source-adapters.local/example-json/adapter.test.ts"],
      "files": ["source-adapters.local/example-json/fixture.json"]
    }
  ]
}
```

| Field | Purpose |
| --- | --- |
| `sourceId` | Identifies the registered adapter. |
| `adapterPath` | An `adapter.ts` or `adapter.mts` module under `source-adapters.local/`, exporting `adapter`. |
| `testFiles` | Lists fixed tests to run against the original and proposed adapter. |
| `files` | Additional sanitized `.ts`/`.json`/`.html`/`.txt` helpers or fixtures; adapter and test files are already included. |

The inert example supplies [adapter.ts](../examples/source-repair/adapter.ts), [adapter.test.ts](../examples/source-repair/adapter.test.ts) and [fixture.json](../examples/source-repair/fixture.json); copy these to `source-adapters.local/example-json/` for the configuration above. Its separate [failing-page.json](../examples/source-repair/failing-page.json) is synthetic present-null test input. The example is unregistered and offline-only; replace it with your own approved source before normal registration. Supply immutable tests and exclude credentials/private session data. Only explicitly listed targets and files are admitted. Use static fixture imports as shown in the example so declared fixtures are bundled when sandbox tests are compiled.

## Configure the local model

Keep Ollama running. Repair is disabled by default (`SOURCE_REPAIR_ENABLED=0`). To enable it, set these values in `.env.local`, replacing the model placeholder with your downloaded model's exact tag:

```dotenv
SOURCE_REPAIR_ENABLED=1
SOURCE_REPAIR_MODEL=your-downloaded-model:tag
SOURCE_REPAIR_OLLAMA_URL=http://127.0.0.1:11434
```

An absent or blank `SOURCE_REPAIR_MODEL` falls back to `AI_TEXT_MODEL` only when `AI_TEXT_PROVIDER=ollama`; there is no non-Ollama model fallback. An absent or blank `SOURCE_REPAIR_OLLAMA_URL` uses `OLLAMA_BASE_URL`, then `http://127.0.0.1:11434`. Only loopback Ollama origins are accepted. Process settings override file values. Repair verifies local model metadata before chat, rejects cloud-backed aliases and never downloads a model.

## Run and inspect

The unattended runner invokes the optional batch after a completed run when ownership is idle. Unavailable repair preserves discovery's result. To prepare or run a batch manually, use the completed invocation's ISO start/end times, at most six hours apart:

```powershell
pnpm repair prepare --since "<start-ISO>" --until "<end-ISO>" --limit 2
pnpm repair run --since "<start-ISO>" --until "<end-ISO>" --limit 2
pnpm repair inspect
pnpm repair test --job "<64-hex-job-id>"
```

`prepare` collects bounded diagnostics/job metadata without inference, even when enabled. `run` may request proposals when enabled and discovery/Ollama are idle. `inspect` lists jobs; add `--job "<64-hex-job-id>"` to select one. `test` validates a saved proposal offline without new inference. Replace the placeholders; use the ID returned by `inspect`. `--limit` accepts 1 or 2, and `--quiet` suppresses progress. The Windows equivalent is `scripts\source-repair-sandbox.cmd` with the same arguments. Job evidence is retained under `work/source-repairs/`.

## What a proposal proves

Supported textual changes may include renamed or nested description fields, text-extraction selectors and null text fields. These examples do not authorize endpoint, identity or count rewrites; source access rules and surrounding guards remain. Eligibility depends on your adapter; unsupported cases remain unavailable.

For supported JSON failures, bounded sanitized evidence can preserve the failed page and a trusted parser stage may specify `replay.operation`. A live-fix claim requires the exact original failure to reproduce before the candidate passes the same replay and immutable tests. Without independently captured count bounds, saved-page success remains `replay_limited`; missing or changed evidence stays unproven. Raw HTML capture/replay is unsupported; HTML literal proposals use your fixtures and do not establish a live-page fix.

The sandbox has no network or private host mounts. Tests are immutable. Each case can use an initial proposal and one correction from sanitized validation feedback, sharing a maximum of two actual model calls per batch. Persistent identities and budgets prevent unchanged cases from restarting indefinitely. Provider, baseline, containment or resource failures stop the case.

Review the saved proposal and test evidence before manually changing your adapter. A passing sandbox proposal is not a guarantee of future source availability.
