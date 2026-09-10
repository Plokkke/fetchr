# Fetchr WebSocket Protocol

Single WebSocket endpoint at the root (`/`). All interactions — control, events, and binary upload — flow through this one connection.

## Connection

- **URL**: `ws://<host>:<port>/` or `wss://...` behind TLS/reverse proxy
- **Auth**: header `x-api-key: <uuid>` on the HTTP upgrade handshake. Rejection closes with code `4401`.
- **Ping/pong**: server pings every 30s, client must respond or connection is terminated.
- **Reconnect**: no server-side state beyond subscriptions. Clients reconnect and re-subscribe.

## Envelope

Every text frame follows:

```json
{ "topic": "<string>", "payload": <any> }
```

- `topic` is either a **global** topic (no prefix) or a **scoped** topic `<scope>::<action>`.
- `payload` is topic-specific. Absent only for a few pure commands (still recommended to send `{}`).
- `requestId` (optional, scoped uplink only) asks the server for an `ack` — see below.

### Acknowledgements

Any scoped uplink event may carry a client-chosen `requestId`. The server then answers **that client only** with a global `ack`:

```json
{ "topic": "ack", "payload": { "requestId": "<id>", "ok": true, "data": <handler result> } }
{ "topic": "ack", "payload": { "requestId": "<id>", "ok": false, "error": "<message>" } }
```

`data` depends on the verb: `download::register` and `download::update` return the `DownloadingInfos`, the other verbs return nothing. Invalid payloads, unknown scopes and handler failures (no plugin for the URL, unknown id, …) all surface as `ok: false`. Without `requestId` nothing is sent back and failures are only logged server-side.

Binary frames use a type-prefix byte. See [§ Upload binary](#upload-binary-frames).

## Scopes

| Scope | Role | Subscribable | Client uplink |
|---|---|---|---|
| *(global)* | Transport | — | `subscribe`, `unsubscribe` |
| `download` | Download lifecycle | yes | `register`, `cancel`, `suspend`, `resume`, `remove`, `clear`, `update` |
| `settings` | Server capabilities | yes (snapshot only) | — |
| `upload` | Binary data-plane for `fetchr-push://…` URLs | no (unicast) | `error` (+ binary chunks) |

## Global topics

### `subscribe`

```json
{
  "topic": "subscribe",
  "payload": {
    "topics": ["download::registered", "download::progress", "download::list", "settings::plugins"]
  }
}
```

Subscribe to any number of scoped topics. Topics must include their scope prefix.

**Snapshot topics** (currently `download::list`, `settings::plugins`) are pushed **once** to this client upon subscribe, then not again. If you resubscribe you get a fresh snapshot.

**Event topics** (e.g. `download::progress`) register the client for future broadcasts. A subset (see "snapshot + updates" hybrid below) also pushes a one-shot snapshot first.

### `unsubscribe`

```json
{ "topic": "unsubscribe", "payload": { "topics": ["download::progress"] } }
```

Removes the client from the broadcast set for those topics. Idempotent.

## Scope: `download`

### Uplink — `register`

Create a download.

```json
{
  "topic": "download::register",
  "payload": {
    "url": "https://1fichier.com/?abc",
    "metadata": { "imdb": "tt1234567" }
  }
}
```

A URL already registered and not Failed is **not** downloaded twice: the existing item is returned (in the `ack`) and no `download::registered` is emitted.

Special form for push uploads: `url: "fetchr-push://<uuid>"`, `metadata.fileName`, `metadata.size` (stringified int). The client must have the same WS connection open since the upload data-plane unicasts back through it.

### Uplink — `cancel`

```json
{ "topic": "download::cancel", "payload": { "id": "<downloadId>" } }
```

Stops an in-flight download, deletes the partial file, broadcasts `download::canceled`.

### Uplink — `suspend` / `resume`

```json
{ "topic": "download::suspend", "payload": { "id": "<downloadId>" } }
{ "topic": "download::resume",  "payload": { "id": "<downloadId>" } }
```

> Currently stubbed server-side (no-op + warn). To be wired to `engine.suspend/resume`.

### Uplink — `remove`

```json
{ "topic": "download::remove", "payload": { "id": "<downloadId>" } }
```

Removes a finished (Completed / Failed) item from the registry. Broadcasts `download::removed`.

### Uplink — `update`

```json
{ "topic": "download::update", "payload": { "id": "<downloadId>", "metadata": { "imdbid": "tt7654321" } } }
```

Replaces the metadata of a not-yet-completed item (Queued / Resolving / Suspended / Downloading / Extracting / Failed). The `download::completed` event then carries the new metadata. Broadcasts `download::updated`; unknown or Completed ids are ignored with a server-side warning. Also exposed as `PATCH /downloads/:id/metadata` with body `{ "metadata": {...} }`.

### Uplink — `clear`

```json
{ "topic": "download::clear", "payload": {} }
```

Remove all Completed and Failed items. Broadcasts N × `download::removed`.

### Downlink events (broadcast)

Every event below carries the item's `metadata` (absent when none was set), so a listener can key its behaviour on what the download is for rather than on its file.

| Topic | Payload shape | When |
|---|---|---|
| `download::registered` | `DownloadingInfos` | After `engine.download()` creates the item |
| `download::progress` | `{ id, status, fileName, progress, speed, eta, downloaded, metadata }` | Throttled every 500 ms during Resolving/Downloading/Extracting |
| `download::suspended` | `{ id, status, fileName, size, metadata }` | Status → Suspended (auto, waiting for a slot) |
| `download::resumed` | `{ id, status, fileName, size, metadata }` | *(not emitted yet, reserved)* |
| `download::completed` | `{ id, fileName, filePaths, size, source, metadata, downloadedAt, completedAt }` | Status → Completed |
| `download::failed` | `{ id, fileName, error, source, metadata }` | Status → Failed |
| `download::canceled` | `{ id, metadata }` | User `cancel` verb succeeded |
| `download::removed` | `{ id, metadata }` | User `remove`/`clear` succeeded |
| `download::updated` | `{ id, metadata }` | User `update` verb succeeded |

### Downlink snapshot

| Topic | Payload | When |
|---|---|---|
| `download::list` | `DownloadingInfos[]` | One-shot on `subscribe` to this topic |

Subsequent updates come via the event topics above, not via `download::list`. Re-subscribe for a fresh snapshot.

## Scope: `settings`

### Downlink snapshot

| Topic | Payload | When |
|---|---|---|
| `settings::plugins` | `{ hosts: [{ name, urlPattern }], archives: [string] }` | One-shot on `subscribe` |

No event updates (capabilities don't change at runtime). No uplink topics.

## Scope: `upload`

Data-plane for `fetchr-push://<token>` sessions. All messages are **unicast** to the client holding the active push session, not broadcast-subscribable.

### Uplink — `error`

```json
{
  "topic": "upload::error",
  "payload": { "token": "<uuid>", "seq": 0, "reason": "ENOENT" }
}
```

Signals that the push client failed to read a specific chunk. The server aborts that read; the overall download typically fails.

### Downlink — `read`

```json
{
  "topic": "upload::read",
  "payload": { "token": "<uuid>", "seq": 0, "start": 0, "length": 5242880 }
}
```

The server asks the client to send bytes `[start, start+length)` of the file identified by `token`. Response is one or more binary frames (see below). `start` defaults to `0`, `length` defaults to `size - start`.

### Downlink — `close`

```json
{ "topic": "upload::close", "payload": { "token": "<uuid>" } }
```

The server signals it has all bytes it needed. The client can disconnect.

### Downlink — `error`

```json
{
  "topic": "upload::error",
  "payload": { "token": "<uuid>", "reason": "disk full" }
}
```

Server-side failure. Client should clean up and disconnect.

### Upload binary frames

Binary frames always start with a **1-byte message type**. Currently only `PUSH_CHUNK = 0x01` is defined; the `0x01 – 0x1F` range is reserved for upload-related types.

```
[0x01 PUSH_CHUNK][token 16 B][seq u32 BE][idx u32 BE][count u32 BE][bytes...]
```

Header total = 29 bytes. `token` is the UUID (binary, not ASCII). For a `read { token, seq, length }` with a chunk size `C`, the client sends `count = ceil(length / C)` chunks with `idx` from `0` to `count - 1`.

Backpressure is the client's responsibility: check `ws.bufferedAmount` (browsers) or the equivalent in Node, pause before pushing the next chunk if it's above a threshold (suggested 16 MB).

## Example: grab (download management)

```text
C → S  { "topic": "subscribe", "payload": {
           "topics": ["download::list", "download::registered", "download::progress",
                      "download::completed", "download::failed", "download::canceled",
                      "download::removed", "download::updated", "settings::plugins"]
         } }
S → C  { "topic": "download::list",    "payload": [ ... ] }       # snapshot
S → C  { "topic": "settings::plugins", "payload": { ... } }        # snapshot

C → S  { "topic": "download::register",
         "payload": { "url": "https://1fichier.com/?abc", "metadata": {"imdb":"tt1"} } }
S → *  { "topic": "download::registered", "payload": { "id": "<uid>", ... } }   # broadcast
S → *  { "topic": "download::progress",   "payload": { ... } }                   # every 500ms
S → *  { "topic": "download::completed",  "payload": { ... } }

C → S  { "topic": "download::remove", "payload": { "id": "<uid>" } }
S → *  { "topic": "download::removed", "payload": { "id": "<uid>" } }
```

## Example: push (upload a local file)

```text
C → S  { "topic": "subscribe", "payload": {
           "topics": ["download::registered", "download::completed",
                      "download::failed", "download::canceled"]
         } }
C → S  { "topic": "download::register",
         "payload": { "url": "fetchr-push://<token>",
                      "metadata": { "fileName": "movie.mkv", "size": "5242880" } } }

S → C  { "topic": "download::registered", "payload": { "id": "<uid>", "url": "fetchr-push://<token>", ... } }
S → C  { "topic": "upload::read", "payload": { "token": "<token>", "seq": 0, "start": 0, "length": 5242880 } }

C → S  <binary PUSH_CHUNK frames for (token, seq=0)>

S → C  { "topic": "download::progress", ... }      # while bytes flow in
S → C  { "topic": "upload::close",      "payload": { "token": "<token>" } }
S → C  { "topic": "download::completed", "payload": { "id": "<uid>", ... } }
```

## Status codes

| Code | Meaning |
|---|---|
| 1000 | Normal close (initiated by client) |
| 4401 | Auth failure (invalid or missing `x-api-key`) |

## Implementation notes

- **Sub registry is per-scope**: each scope gateway tracks its own subscribers. Broadcasts only iterate subscribed clients.
- **One JSON.stringify per broadcast**: the serialized message is shared across all subscribers.
- **Cleanup**: disconnect triggers cleanup in every scope gateway (`onDisconnected`). Subscriptions are purged in O(k) where k = topics subscribed by this client.
- **Snapshot handlers take precedence**: when a topic has a custom snapshot handler, the default "add to subscribers" behaviour does NOT run — the handler decides. To opt into both snapshot + broadcasts, the handler calls the internal `registerSubscriber(client, topic)` helper (see `protocols/download/service.ts`).
