<h1 align="center">
  <img src="public/favicon.svg" width="76" height="76" alt="Auction Discovery icon"><br>
  Auction Discovery
</h1>

<p align="center"><strong>A local workspace for finding and reviewing auction equipment.</strong></p>

<p align="center">
  <img alt="Windows" src="https://img.shields.io/badge/Windows-10%20%2F%2011-6d28d9">
  <img alt="Node.js" src="https://img.shields.io/badge/Node.js-22.13%2B-6d28d9">
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/License-MIT-6d28d9"></a>
</p>

Auction Discovery collects listings from sources you configure, keeps their original details and images, estimates pickup proximity, and gives you one place to mark what interests you. Search, filters, grid and list views, listing details, and review history help you work through a catalog at your own pace.

**Bring your own sources.** This release includes generic JSON, HTML, and headless-browser adapter templates. It starts with an empty catalog and no enabled sources. Listings are **Unrated** by default; no trained preference model, training data, credentials, or private source integrations are included.

## How it works

1. **Configure** your ZIP code and authorized source adapters.
2. **Discover** current inventory with bounded requests and explicit source status. A denied, challenged, or incomplete source keeps its previous valid publication.
3. **Review** source facts, archived images, pickup estimates, and closing information. Mark listings Interested or Not interested, undo a vote, and revisit your history.
4. **Repeat** manually or use the optional Windows schedule. Stored details remain immutable, and missing preparation resumes from retained evidence.

Pickup estimates use bundled US Census geography. They are approximate proximity estimates, not live traffic or turn-by-turn directions.

## Screenshots

These screenshots show the author's configured installation. Its source integrations, catalog, generated interest profile, and numeric model scores are illustrations; they are not bundled with this release. A fresh installation starts empty and shows Unrated listings after you connect your own sources.

<p align="center"><img src="docs/screenshots/screenshot1.png" width="850" alt="Discovery dashboard in grid view"></p>

<details>
<summary>Listing details and list view</summary>

![Listing details](docs/screenshots/screenshot2.png)
![Discovery list view](docs/screenshots/screenshot3.png)

</details>

<details>
<summary>Configured interest profile</summary>

![Interest profile and positive signals](docs/screenshots/screenshot4.png)
![Negative interest signals](docs/screenshots/screenshot5.png)

</details>

## Requirements

- Windows 10 or 11 with PowerShell 5.1 or newer.
- Node.js 22.13 or newer and the pnpm version declared in `package.json`.
- A modern browser for the local dashboard.
- Chromium installed through Playwright if any of your adapters use headless browsing.

The supplied launcher and scheduling support Windows. Cloudflare's local D1 and R2 emulation stores the database and image objects on your machine; the local workflow does not require a Cloudflare account or deployment.

## Setup

Clone the repository, or download a release source ZIP and extract it to a normal writable folder. Run these commands in that folder:

```powershell
node --version
pnpm --version
.\scripts\setup.cmd
Copy-Item .env.example .env.local
```

Setup installs the locked dependencies and creates `source-adapters.local.ts` if it does not already exist. Preserve your existing `.env.local` when updating an installation. For browser adapters, also run:

```powershell
pnpm browser:install
```

Open **Auction Discovery.cmd**. Wait for **Dashboard runtime is ready**, then visit [localhost:3000](http://localhost:3000). Keep the launcher terminal open while using the application. The dashboard and its local companion run together; start them through this launcher.

To stop, finish or stop active discovery in the dashboard, then press **Ctrl+C** in the launcher terminal. Accept Windows' batch termination prompt if one appears. Runtime logs are under `.wrangler/logs`.

## Configure your location

Open **Settings** and save your five-digit US ZIP code. The example/default is **90210**. The saved origin takes precedence over the initial `ORIGIN_POSTAL_CODE` in `.env.local`. An origin change requires the pipeline to be idle and recalculates local proximity for your catalog.

Set `DEFAULT_TIME_ZONE` in `.env.local` to your preferred IANA time zone, then restart the launcher after editing environment or adapter files.

## Add your own sources

Edit the ignored **`source-adapters.local.ts`** created by setup. It contains three examples and exports an empty registration array. The examples use reserved domains and are not working auction services.

1. Choose `createJsonApiSource`, `createHtmlSource`, or `createHeadlessBrowserSource` and replace its example URLs with an endpoint you are authorized to access.
2. Map stable listing IDs, canonical URLs, titles, current/ended state, descriptions, pickup locations, dates, prices, and explicit image identities from the source response. Use `null` for unavailable facts. An empty image array must represent established image absence.
3. Record the applicable access basis, review date, and evidence in the adapter's `access` policy. For `manual_review_required`, also supply the registration's `manualReview` with approved decision, terms/robots review timestamps, and evidence. A source without a completed review cannot be enabled.
4. Set exact document/image hosts, request pacing, request/byte ceilings, and redirect rules in `requests`. Browser scripts, XHR, fetch, and stylesheets additionally require exact `allowedBrowserRequests` entries; set `browser.readySelector` when rendering needs a specific readiness signal.
5. Register the finished adapter in the default array, initially disabled:

   ```ts
   const sources: readonly SourceRegistration[] = [
     { adapter: mySource, enabled: false },
   ];
   export default sources;
   ```

6. Restart the launcher, inspect the source in **Settings**, enable it, and choose **Run discovery**.

The template factories expect one complete inventory document. A paginated API needs a locally implemented `SourceAdapter` with a complete bounded inventory traversal; do not treat its first page as the whole catalog. HTML templates require a recognized inventory container and a distinct explicit-empty marker. Headless browser templates require inline listing details so import can finish from captured evidence.

The interfaces in [`lib/sources/types.ts`](lib/sources/types.ts), [`generic.ts`](lib/sources/generic.ts), and [`registration.ts`](lib/sources/registration.ts) define the extension boundary. [`source-adapters.example.ts`](source-adapters.example.ts) supplies the mappings; [`tests/sources`](tests/sources) and [`tests/public-browser`](tests/public-browser) show synthetic success, empty, malformed, and access-stop cases.

Keep adapters and credentials local. Access denial, challenges, unlisted resources, or ambiguous inventory stop that source; resolve the source's requirements before trying again. The bundled browser driver always runs headless in a disposable context.

## Review and optional AI

Ordinary discovery and review work without AI. Your Interested/Not interested votes and history stay local. **Unrated is the expected default**, and recording votes does not automatically train or activate a score model.

Optional text enrichment can use your own installed Ollama models. Configure all four `AI_TEXT_PROVIDER`, `AI_TEXT_MODEL`, `AI_EMBEDDING_PROVIDER`, and `AI_EMBEDDING_MODEL` values in `.env.local`; use `ollama` for the providers and the exact installed model IDs for the models. The bundled embedding dimension contracts support the `qwen3-embedding` 0.6B, 4B, and 8B families; other embedding models require an explicit compatible dimension contract in the local integration. `OLLAMA_BASE_URL` defaults to localhost. Setup does not download AI models. Enrichment is separate from source acquisition and does not replace original source facts.

Preference scoring requires a compatible model and a local integration supplied by the user. This release has no general training or model-activation workflow. The configured profile and numeric scores in the screenshots are not the behavior of a fresh checkout.

## Scheduling and local data

Use **Settings → Scheduled discovery** to opt into a Windows schedule. Saving that setting creates or updates tasks scoped to this checkout. The computer must be available at the scheduled time; the dashboard reports completed, paused, blocked, and failed work distinctly.

Configuration, source adapters, database state, cached images, votes, logs, and runtime receipts are local and ignored by Git. Preserve `.env.local`, `source-adapters.local.ts`, and `.wrangler` when updating. Stop the application before copying its data folder for a backup. Do not copy another installation's runtime state into a running checkout.

## Development

```powershell
pnpm typecheck
pnpm test
pnpm build
```

Browser tests require the Chromium installation above. Tests use synthetic fixtures; no production source adapters or catalog are part of the suite. The normal local application uses the supervised launcher even when developing.

Built with React, TypeScript, Vinext/Vite, SQLite-compatible D1, R2, and Playwright. Bundled geography provenance is documented in [`lib/routing/data/README.md`](lib/routing/data/README.md).

## License

[MIT](LICENSE) © 2026 wivy1
