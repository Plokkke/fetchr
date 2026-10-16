# Fetchr

A small download manager for file hosts. Give it a URL, it resolves the real file through a host plugin, downloads it with resume support, extracts it if it is an archive, and reports every step over a WebSocket. It knows nothing about what it downloads: callers attach free-form `metadata` to a download and get it back on every event.

## Features

- **Host plugins** — resolve a URL into a file name, size and stream. Built-in: `one-fichier` (1fichier API), `fetchr-push` (bytes streamed back over the WebSocket from a push client). External plugins load from an npm package name.
- **Archive plugins** — detect by header and extract after download. Built-in: `zip`, `rar`.
- **Resumable downloads** — writes to `<file>.part`, the partial file being the only checkpoint; resumes with `Range` / `If-Range` and checks a 1 MiB overlap before appending.
- **Persistent state** — the registry survives restarts (`<DOWNLOADS_PATH>/.fetchr-state.json`); unfinished items are resumed at boot.
- **Scheduling** — at most `MAX_CONCURRENT_DOWNLOADS` in flight; items can be suspended and resumed.
- **Dedup** — registering a URL already known and not failed returns the existing item.

Lifecycle: `queued → resolving → (suspended) → downloading → (extracting) → completed | failed`.

## API

Every call needs the API key: header `x-api-key`, or `?apiKey=` on the WebSocket URL (browsers cannot set upgrade headers).

**WebSocket** on `/` — the main interface: subscribe to `download::*` events and snapshots, send `download::register | cancel | suspend | resume | update | remove | clear`, get an `ack` when a `requestId` is supplied. Full reference: [`docs/WS_PROTOCOL.md`](docs/WS_PROTOCOL.md).

**HTTP**

| Route | Purpose |
|---|---|
| `GET /downloads/resolve?url=` | Resolve a URL (file name, size) without downloading |
| `POST /downloads` | Register `{ url, metadata? }` |
| `GET /downloads`, `GET /downloads/:id` | List / get |
| `PATCH /downloads/:id/metadata` | Replace metadata of a non-completed item |
| `POST /downloads/:id/suspend`, `POST /downloads/:id/resume` | Pause / resume |
| `DELETE /downloads/:id` | Cancel (in flight) or remove (finished) |
| `DELETE /downloads/completed` | Clear finished items |
| `GET /plugins` | Loaded host plugins (`name`, `urlPattern`) and archive plugins |
| `GET /health` | Status and running version `{ status, version }` (no key) |
| `GET /health/startup`, `/health/liveness`, `/health/readiness` | Health checks (no key) |

## Configuration

| Variable | Required | Description |
|---|---|---|
| `API_KEY` | yes | Shared secret for HTTP and WebSocket |
| `DOWNLOADS_PATH` | yes | Where files, extractions and the state file go |
| `HOST_PLUGINS` | yes | Comma-separated, e.g. `one-fichier,fetchr-push` |
| `ARCHIVE_PLUGINS` | no | Comma-separated, e.g. `zip,rar` |
| `MAX_CONCURRENT_DOWNLOADS` | no | Default `3` |
| `PORT` | no | Default `3000` |
| `LOG_LEVEL` | no | Default `info` in production, `debug` otherwise |
| `SHUTDOWN_TIMEOUT_MS` | no | Graceful shutdown budget |
| `APP_VERSION` | no | Reported by `/health`; set by the image build |
| `ONE_FICHIER_HOST`, `ONE_FICHIER_API_KEY` | with `one-fichier` | 1fichier API host and key |

## Development

```bash
npm install
npm run start:dev          # reads .env
npm run validate           # lint + build + unit/e2e tests with coverage
npm run test:unit
```

Source map:

```
src/
├── gateways/          WebSocket gateway + one protocol per scope (download, settings, upload)
├── controllers/       HTTP routes
├── services/          download-engine, resume, state-store, archive-extractor, push sessions
└── plugins/           host/archive contracts, loader, built-in/
```

### Writing a plugin

A host plugin implements `HostPlugin` (`src/plugins/host-plugin.ts`): a `name`, a `urlPattern` (published by `GET /plugins` so clients can spot supported links), `canHandle(url)` and `resolve(item)` returning the file infos and an `open({ from, etag })` that honours byte ranges. An archive plugin implements `ArchivePlugin` (`src/plugins/archive-plugin.ts`). Built-ins are registered in `src/plugins/plugin-loader.ts`; any other name in `HOST_PLUGINS` / `ARCHIVE_PLUGINS` is imported as a package whose default export is a factory.

## Deployment

Images: `ghcr.io/plokkke/fetchr:<version>` (`linux/amd64`, `linux/arm64`, non-root uid 1000), published by `release.yml` after semantic-release. Mount a volume on `DOWNLOADS_PATH`: it holds the downloads and the state file needed to resume after a restart.

The author's own instance runs on a home server: `infrastructure/terraform` is its stack (applied by the server's deployer through `deploy.yml`), `infrastructure/secrets/production.sops.yaml` its encrypted credentials. Rollback: `gh workflow run deploy -f version=<previous>`.
