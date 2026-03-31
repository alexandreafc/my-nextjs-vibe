# Logs Tab & Real-Time Streaming Design

**Date**: 2026-03-31
**Status**: Approved

## Overview

Add a "Logs" tab to the main project interface (alongside Demo and Code) that displays real-time logs from the e2b sandbox. Three log sources: Next.js dev server output, browser console logs (from the preview iframe), and agent execution logs (admin-only). Streaming powered by Redis PubSub → SSE, with hybrid persistence (live streaming + last 100 entries saved to DB on completion).

## Decisions Log

| Decision | Choice | Alternatives Considered |
|----------|--------|------------------------|
| Admin control | Prisma User table with `isAdmin` + Clerk webhook sync | Clerk publicMetadata |
| Log persistence | Hybrid: live streaming + persist last 100 on completion | Live-only; full DB persistence |
| Browser console capture | Injected script (`postMessage`) + server-side via e2b | postMessage only; proxy only |
| Streaming transport | Redis PubSub → SSE endpoint → EventSource client | Prisma + tRPC polling; Prisma + SSE |

## 1. UI Layout

### Main Tab Bar

Three tabs in the existing `TabsList`: **Demo** | **Code** | **Logs**

The Logs tab shows a green dot indicator when the SSE connection is active.

Tab state type expands from `"preview" | "code"` to `"preview" | "code" | "logs"`.

### Logs Tab Content — Resizable Split

Uses `ResizablePanelGroup` (same component already used for the main chat/preview split).

**Left panel (default 62%)**: Sub-tabs "Server" and "Console"
- **Server**: stdout/stderr from the Next.js dev server process running in the sandbox
- **Console**: browser `console.log/warn/error/info/debug` and uncaught errors from the preview iframe

**Resize handle**: Draggable divider between panels.

**Right panel (default 38%)**: Agent Logs — only rendered when `isAdmin === true`
- Shows tool calls (createOrUpdateFiles, readFiles), command executions (npm install, tsc), verification steps, and agent completion status
- Tagged with badges: `TOOL`, `CMD`, `VERIFY`, `DONE`

**Non-admin view**: Left panel expands to 100% width. No resize handle, no right panel.

### Status Bar

Each panel has a bottom status bar with:
- Connection status indicator (green "Live" / grey "Disconnected")
- Entry count
- Filter input
- Clear button

## 2. Streaming Architecture

### Data Flow

```
e2b Sandbox (onStdout/onStderr callbacks)
    ↓
Inngest Function (classifies: source + level)
    ↓
Redis PubSub (channel: logs:{projectId})
    ↓                          ↓
SSE Endpoint (/api/logs/stream)   Prisma (on agent completion, last 100)
    ↓
EventSource (client)
    ↓
React State → Log Viewer UI

---

iframe (preview)
    ↓ (injected script overrides console.*)
postMessage → parent window
    ↓
React State → Console Tab UI (no server roundtrip)
```

### Log Classification in Inngest

The Inngest function (`codeAgentFunction`) publishes logs to Redis at these points:

1. **Agent tool calls** → `source: "agent"`, `metadata.type: "tool"` — when `createOrUpdateFiles`, `readFiles`, or `terminalTool` are invoked
2. **Command stdout/stderr** → `source: "server"` for dev server output, `source: "agent"` for agent-initiated commands (npm install, tsc, etc.) — distinguished by whether the command is the background dev server process or an agent tool call
3. **Verification steps** → `source: "agent"`, `metadata.type: "verify"` — health check results
4. **Agent lifecycle** → `source: "agent"`, `metadata.type: "lifecycle"` — agent start, iteration count, completion

### Redis Configuration

- **Client library**: `ioredis`
- **Channel pattern**: `logs:{projectId}`
- **Two connections**: One publisher (in Inngest function), one subscriber (in SSE endpoint)
- **No TTL on channel** — messages are ephemeral PubSub (not stored in Redis). Persistence handled by Prisma.
- **Connection**: Via `REDIS_URL` env variable

### SSE Endpoint

**Route**: `GET /api/logs/stream?projectId={projectId}`

**Server logic**:
1. Verify Clerk auth → extract `userId`
2. Verify user owns the project (`Project.userId === clerkId`)
3. Lookup `User.isAdmin` from Prisma
4. Create Redis subscriber, subscribe to `logs:{projectId}`
5. On each Redis message: if `source === "agent" && !isAdmin` → skip
6. Otherwise: write SSE event to response stream
7. Send heartbeat every 30s to keep connection alive
8. On client disconnect: unsubscribe from Redis, close subscriber

**SSE event types**:
- `event: connected` — initial event with `{ projectId, isAdmin }`
- `event: log` — log entry with full message payload
- `event: heartbeat` — keep-alive with timestamp

**Headers**:
```
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
```

## 3. Data Model

### New: User Model

```prisma
model User {
  id        String   @id @default(cuid())
  clerkId   String   @unique
  email     String
  isAdmin   Boolean  @default(false)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}
```

Standalone table — not linked to Project via FK. Project continues to use `userId` as a Clerk ID string. User table exists for `isAdmin` lookup and future extensibility.

**Sync mechanism**: Clerk webhook at `/api/webhooks/clerk` listens for `user.created` and `user.updated` events. Creates/updates the User row. `isAdmin` is set manually via database or future admin UI.

### New: Log Model

```prisma
model Log {
  id        String    @id @default(cuid())
  projectId String
  messageId String?
  source    LogSource
  level     LogLevel
  content   String
  metadata  Json?
  timestamp DateTime  @default(now())

  project   Project   @relation(fields: [projectId], references: [id])
  message   Message?  @relation(fields: [messageId], references: [id])

  @@index([projectId, timestamp])
  @@index([messageId])
}
```

- `messageId` is nullable — null during live streaming, set when persisting on agent completion
- `metadata` stores structured data: `{ type: "tool" | "cmd" | "verify" | "lifecycle", files?: string[], exitCode?: number, stdout?: string }`
- Composite index on `(projectId, timestamp)` for efficient time-ordered queries
- Secondary index on `messageId` for loading logs of a specific execution

### New: Enums

```prisma
enum LogSource {
  SERVER
  AGENT
}

enum LogLevel {
  INFO
  WARN
  ERROR
  DEBUG
}
```

### Modified: Existing Models

Add relations to Project and Message:

```prisma
// In Project model:
logs Log[]

// In Message model:
logs Log[]
```

## 4. Console Capture (iframe postMessage)

### Injected Script

Added to the sandbox Next.js template via `template.ts` (which generates the root layout). Injected as a `<script>` tag in the `<head>` of the root layout so it runs on every page before any app code.

**Behavior**:
- Overrides `console.log`, `console.warn`, `console.error`, `console.info`, `console.debug`
- Captures `window.onerror` and `unhandledrejection` events
- Serializes arguments via `JSON.stringify` with circular reference protection
- Sends to parent window via `window.parent.postMessage()`
- Original console methods are still called (user sees logs in browser devtools too)

**Message format**:
```json
{
  "type": "console-log",
  "level": "log" | "warn" | "error" | "info" | "debug",
  "args": ["...serialized arguments"],
  "timestamp": "ISO-8601"
}
```

**Security**: The `useConsoleCapture` hook validates `event.data.type === "console-log"` before processing. No sensitive data is exposed — console output is developer-authored content.

## 5. Client Hooks

### useLogStream(projectId: string)

- Creates `EventSource` connection to `/api/logs/stream?projectId={projectId}`
- Parses incoming SSE `log` events into typed log entries
- Maintains an in-memory array of log entries (capped at 1000 to prevent memory issues)
- Exposes: `serverLogs`, `agentLogs`, `isConnected`, `clearLogs()`
- Auto-reconnects on connection loss (EventSource built-in behavior)
- Cleans up EventSource on unmount

### useConsoleCapture()

- Attaches `window.addEventListener("message", handler)` listener
- Filters for `event.data.type === "console-log"` messages
- Maintains in-memory array of console entries (capped at 500)
- Exposes: `consoleLogs`, `clearConsoleLogs()`
- Cleans up listener on unmount

### useLogHistory(projectId: string)

- tRPC query to fetch persisted logs from Prisma
- Loads logs for the current project, ordered by timestamp desc
- Used to show logs from previous executions when the user first opens the Logs tab
- Merged with live stream: historical logs shown first, then live entries appended

## 6. Persistence Strategy

**Live phase**: All logs flow through Redis PubSub → SSE. Nothing written to Prisma during execution.

**On agent completion** (in `codeAgentFunction`, after the agent loop finishes):
1. Collect the last 100 log entries from the Redis-published stream (buffered in the Inngest function)
2. Bulk insert into the `Log` table with `messageId` set to the RESULT/ERROR message ID
3. Both `source: "server"` and `source: "agent"` logs are persisted

**On page load** (when user opens Logs tab):
1. `useLogHistory` fetches persisted logs via tRPC
2. If sandbox is active, `useLogStream` opens SSE connection for live logs
3. UI merges: historical logs rendered first, then live entries appended below

**Console logs are NOT persisted** — they exist only in React state for the current session.

## 7. New Dependencies

| Package | Purpose |
|---------|---------|
| `ioredis` | Redis client for PubSub (publisher in Inngest, subscriber in SSE endpoint) |

**Infrastructure**: Requires a Redis instance. Connection via `REDIS_URL` environment variable.

## 8. File Inventory

### New Files (8)

| File | Purpose |
|------|---------|
| `src/app/api/logs/stream/route.ts` | SSE endpoint — Redis subscriber, auth gate, stream to client |
| `src/app/api/webhooks/clerk/route.ts` | Clerk webhook — sync User table on user.created/updated |
| `src/hooks/use-log-stream.ts` | EventSource hook for live server + agent logs via SSE |
| `src/hooks/use-console-capture.ts` | postMessage listener hook for iframe console logs |
| `src/hooks/use-log-history.ts` | tRPC hook for loading persisted logs from DB |
| `src/modules/projects/ui/components/logs-panel.tsx` | Logs tab container with resizable split + sub-tabs |
| `src/modules/projects/ui/components/log-viewer.tsx` | Shared log rendering component (monospace, colored levels, timestamps) |
| `src/lib/redis.ts` | Redis client singleton (ioredis) |

### Modified Files (6)

| File | Change |
|------|--------|
| `prisma/schema.prisma` | Add User model, Log model, LogSource enum, LogLevel enum, relations |
| `src/modules/projects/ui/views/project-view.tsx` | Add Logs tab trigger + content, expand tab state type |
| `src/inngest/functions.ts` | Import Redis publisher, publish logs on e2b callbacks and tool calls, buffer + persist on completion |
| `sandbox-templates/nextjs/template.ts` | Inject console capture script into sandbox app layout |
| `package.json` | Add `ioredis` dependency |
| `.env` | Add `REDIS_URL` variable |

## 9. e2b SDK Version Note

Current versions: `e2b: ^2.18.0`. Latest documented JS SDK: v2.3.4. The current version supports all required features (`commands.run` with `onStdout`/`onStderr` callbacks). SDK upgrade is recommended but not blocking for this feature.
