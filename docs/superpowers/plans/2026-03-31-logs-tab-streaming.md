# Logs Tab & Real-Time Streaming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Logs" tab with real-time streaming of sandbox logs (server, console, agent) via Redis PubSub → SSE, with admin-only agent logs and hybrid persistence.

**Architecture:** Inngest function publishes classified logs to Redis PubSub channels per project. A Next.js SSE endpoint subscribes and streams to the client, filtering agent logs for non-admins. Browser console logs bypass the server entirely via iframe postMessage. On agent completion, last 100 entries are persisted to Prisma.

**Tech Stack:** ioredis, Next.js Route Handlers (SSE), EventSource API, Prisma (User + Log models), Clerk webhooks, postMessage API

---

## File Map

### New Files

| File | Responsibility |
|------|---------------|
| `src/lib/redis.ts` | ioredis singleton (publisher + subscriber factory) |
| `prisma/schema.prisma` (modify) | User model, Log model, LogSource/LogLevel enums |
| `src/app/api/webhooks/clerk/route.ts` | Clerk webhook handler — sync User table |
| `src/app/api/logs/stream/route.ts` | SSE endpoint — Redis subscriber, auth gate, stream |
| `src/hooks/use-log-stream.ts` | EventSource hook for live SSE logs |
| `src/hooks/use-console-capture.ts` | postMessage listener for iframe console logs |
| `src/modules/logs/server/procedures.ts` | tRPC router for persisted log queries (history loaded via `trpc.logs.getByProject` in LogsPanel) |
| `src/modules/projects/ui/components/log-viewer.tsx` | Shared monospace log renderer |
| `src/modules/projects/ui/components/logs-panel.tsx` | Logs tab container with resizable split + sub-tabs |

### Modified Files

| File | Change |
|------|--------|
| `package.json` | Add `ioredis`, `svix` (Clerk webhook verification) |
| `prisma/schema.prisma` | Add User, Log, enums, relations on Project/Message |
| `src/inngest/functions.ts` | Redis publish on e2b callbacks + tool calls, buffer + persist on completion |
| `src/modules/projects/ui/views/project-view.tsx` | Add Logs tab trigger + content |
| `sandbox-templates/nextjs/template.ts` | Inject console capture script |
| `src/trpc/routers/_app.ts` | Register logs router |
| `src/middleware.ts` | Allow `/api/webhooks/clerk` and `/api/logs/stream` without Clerk redirect |

---

## Task 1: Install Dependencies & Environment Setup

**Files:**
- Modify: `package.json`
- Modify: `.env` (local only, not committed)

- [ ] **Step 1: Install ioredis and svix**

```bash
npm install ioredis svix
```

- [ ] **Step 2: Add REDIS_URL to .env**

Add to your local `.env` file:

```
REDIS_URL=redis://localhost:6379
CLERK_WEBHOOK_SECRET=whsec_your_webhook_secret_here
```

- [ ] **Step 3: Verify ioredis is in package.json**

```bash
grep ioredis package.json
```

Expected: `"ioredis": "^5.x.x"`

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add ioredis and svix dependencies"
```

---

## Task 2: Prisma Schema — User, Log Models & Enums

**Files:**
- Modify: `prisma/schema.prisma`

- [ ] **Step 1: Add enums after existing MessageType enum**

Add after line 36 (`ERROR`) closing brace in `prisma/schema.prisma`:

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

- [ ] **Step 2: Add User model after the Usage model**

Add at the end of `prisma/schema.prisma`:

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

- [ ] **Step 3: Add Log model after User model**

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

  project   Project   @relation(fields: [projectId], references: [id], onDelete: Cascade)
  message   Message?  @relation(fields: [messageId], references: [id], onDelete: Cascade)

  @@index([projectId, timestamp])
  @@index([messageId])
}
```

- [ ] **Step 4: Add `logs` relation to Project model**

In the `Project` model (after `messages Message[]`), add:

```prisma
  logs      Log[]
```

- [ ] **Step 5: Add `logs` relation to Message model**

In the `Message` model (after `fragment Fragment?`), add:

```prisma
  logs      Log[]
```

- [ ] **Step 6: Run Prisma generate and migrate**

```bash
npx prisma generate
npx prisma db push
```

Expected: No errors. Prisma client regenerated with User, Log, LogSource, LogLevel.

- [ ] **Step 7: Commit**

```bash
git add prisma/schema.prisma src/generated/prisma
git commit -m "feat: add User and Log models with enums to Prisma schema"
```

---

## Task 3: Redis Client Singleton

**Files:**
- Create: `src/lib/redis.ts`

- [ ] **Step 1: Create the Redis client module**

Create `src/lib/redis.ts`:

```typescript
import Redis from "ioredis";

const globalForRedis = global as unknown as {
  redisPublisher: Redis;
};

function createRedisClient(): Redis {
  const url = process.env.REDIS_URL;
  if (!url) {
    throw new Error("REDIS_URL environment variable is not set");
  }
  return new Redis(url, {
    maxRetriesPerRequest: 3,
    lazyConnect: true,
  });
}

export const redisPublisher =
  globalForRedis.redisPublisher || createRedisClient();

if (process.env.NODE_ENV !== "production") {
  globalForRedis.redisPublisher = redisPublisher;
}

export function createRedisSubscriber(): Redis {
  const url = process.env.REDIS_URL;
  if (!url) {
    throw new Error("REDIS_URL environment variable is not set");
  }
  return new Redis(url, {
    maxRetriesPerRequest: 3,
    lazyConnect: true,
  });
}
```

Note: Publisher is a singleton (same pattern as `src/lib/db.ts`). Subscriber is a factory — each SSE connection creates its own subscriber (ioredis requires dedicated connections for PubSub subscribers).

- [ ] **Step 2: Verify import works**

```bash
npx tsx -e "import { redisPublisher } from './src/lib/redis'; console.log('Redis module OK')"
```

Expected: `Redis module OK` (may show connection warning if Redis isn't running locally — that's fine).

- [ ] **Step 3: Commit**

```bash
git add src/lib/redis.ts
git commit -m "feat: add Redis client singleton for PubSub"
```

---

## Task 4: Clerk Webhook — User Sync

**Files:**
- Create: `src/app/api/webhooks/clerk/route.ts`
- Modify: `src/middleware.ts`

- [ ] **Step 1: Update middleware to allow webhook route**

In `src/middleware.ts`, update `isPublicRoute` to include the webhook path:

```typescript
const isPublicRoute = createRouteMatcher([
  "/",
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/pricing(.*)",
  "/api/webhooks(.*)",
]);
```

- [ ] **Step 2: Create the Clerk webhook route**

Create `src/app/api/webhooks/clerk/route.ts`:

```typescript
import { Webhook } from "svix";
import { headers } from "next/headers";
import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";

interface ClerkWebhookEvent {
  type: string;
  data: {
    id: string;
    email_addresses: Array<{
      email_address: string;
      id: string;
    }>;
  };
}

export async function POST(req: Request) {
  const secret = process.env.CLERK_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "Webhook secret not configured" },
      { status: 500 }
    );
  }

  const headerPayload = await headers();
  const svixId = headerPayload.get("svix-id");
  const svixTimestamp = headerPayload.get("svix-timestamp");
  const svixSignature = headerPayload.get("svix-signature");

  if (!svixId || !svixTimestamp || !svixSignature) {
    return NextResponse.json(
      { error: "Missing svix headers" },
      { status: 400 }
    );
  }

  const body = await req.text();

  const wh = new Webhook(secret);
  let event: ClerkWebhookEvent;

  try {
    event = wh.verify(body, {
      "svix-id": svixId,
      "svix-timestamp": svixTimestamp,
      "svix-signature": svixSignature,
    }) as ClerkWebhookEvent;
  } catch {
    return NextResponse.json(
      { error: "Invalid webhook signature" },
      { status: 400 }
    );
  }

  const { type, data } = event;

  if (type === "user.created" || type === "user.updated") {
    const email = data.email_addresses?.[0]?.email_address ?? "";

    await prisma.user.upsert({
      where: { clerkId: data.id },
      create: {
        clerkId: data.id,
        email,
        isAdmin: false,
      },
      update: {
        email,
      },
    });
  }

  return NextResponse.json({ received: true });
}
```

- [ ] **Step 3: Commit**

```bash
git add src/app/api/webhooks/clerk/route.ts src/middleware.ts
git commit -m "feat: add Clerk webhook for User table sync"
```

---

## Task 5: Redis Publish in Inngest Function

**Files:**
- Modify: `src/inngest/functions.ts`

This is the core change — publishing logs to Redis as the agent executes.

- [ ] **Step 1: Add imports and log buffer at top of file**

Add these imports at the top of `src/inngest/functions.ts`:

```typescript
import { createId } from "@paralleldrive/cuid2";
import { redisPublisher } from "@/lib/redis";
```

Wait — `cuid2` isn't installed. Use `crypto.randomUUID()` instead (built-in Node.js):

```typescript
import { randomUUID } from "crypto";
import { redisPublisher } from "@/lib/redis";
```

- [ ] **Step 2: Add helper function and log buffer after imports**

Add after the imports block (before the `interface AgentState`):

```typescript
interface LogEntry {
  id: string;
  source: "server" | "agent";
  level: "info" | "warn" | "error" | "debug";
  content: string;
  metadata?: Record<string, unknown> | null;
  timestamp: string;
}

function publishLog(
  projectId: string,
  entry: Omit<LogEntry, "id" | "timestamp">,
  buffer: LogEntry[]
): void {
  const log: LogEntry = {
    id: randomUUID(),
    ...entry,
    timestamp: new Date().toISOString(),
  };
  buffer.push(log);
  redisPublisher
    .publish(`logs:${projectId}`, JSON.stringify(log))
    .catch(() => {});
}
```

- [ ] **Step 3: Initialize log buffer inside codeAgentFunction**

Inside `codeAgentFunction`, right after the opening of the async function (line after `async ({ event, step }) => {`), add:

```typescript
    const logBuffer: LogEntry[] = [];
```

- [ ] **Step 4: Add Redis publish to terminalTool callbacks**

Modify the `terminalTool` handler. Replace the `onStdout` and `onStderr` callbacks:

```typescript
            const result = await sandbox.commands.run(command, {
              timeoutMs: 0,
              onStdout: (data: string) => {
                buffers.stdout += data;
                publishLog(event.data.projectId, {
                  source: "agent",
                  level: "info",
                  content: data,
                  metadata: { type: "cmd", cmd: command },
                }, logBuffer);
              },
              onStderr: (data: string) => {
                buffers.stderr += data;
                publishLog(event.data.projectId, {
                  source: "agent",
                  level: "error",
                  content: data,
                  metadata: { type: "cmd", cmd: command },
                }, logBuffer);
              }
            });
```

- [ ] **Step 5: Add Redis publish to createOrUpdateFiles tool**

Inside the `createOrUpdateFiles` handler, after the `for` loop that writes files (after `updatedFiles[file.path] = file.content;`), but still inside the try block, add after the loop:

```typescript
                publishLog(event.data.projectId, {
                  source: "agent",
                  level: "info",
                  content: `createOrUpdateFiles`,
                  metadata: {
                    type: "tool",
                    files: files.map((f) => f.path),
                  },
                }, logBuffer);
```

- [ ] **Step 6: Add Redis publish to readFiles tool**

Inside the `readFiles` handler, after the `for` loop that reads files, add (still inside try):

```typescript
                publishLog(event.data.projectId, {
                  source: "agent",
                  level: "info",
                  content: `readFiles`,
                  metadata: {
                    type: "tool",
                    files,
                  },
                }, logBuffer);
```

- [ ] **Step 7: Add lifecycle publish for agent completion**

After the `const result = await network.run(...)` line (line 294), add:

```typescript
    publishLog(event.data.projectId, {
      source: "agent",
      level: "info",
      content: "Agent completed",
      metadata: {
        type: "lifecycle",
        verified: result.state.data.verified,
        verificationAttempts: result.state.data.verificationAttempts,
        fileCount: Object.keys(result.state.data.files || {}).length,
      },
    }, logBuffer);
```

- [ ] **Step 8: Persist logs to Prisma on save-result**

Inside the `save-result` step, before the `return` statements, add log persistence. Replace the entire `step.run("save-result", ...)` block:

```typescript
    await step.run("save-result", async () => {
      let message;

      if (isError) {
        message = await prisma.message.create({
          data: {
            projectId: event.data.projectId,
            content: "Something went wrong. Please try again.",
            role: "ASSISTANT",
            type: "ERROR",
          },
        });
      } else {
        message = await prisma.message.create({
          data: {
            projectId: event.data.projectId,
            content: parseAgentOutput(responseOutput),
            role: "ASSISTANT",
            type: "RESULT",
            fragment: {
              create: {
                sandboxUrl: sandboxUrl,
                title: parseAgentOutput(fragmentTitleOuput),
                files: result.state.data.files,
              },
            },
          },
        });
      }

      // Persist last 100 log entries
      const logsToSave = logBuffer.slice(-100);
      if (logsToSave.length > 0) {
        await prisma.log.createMany({
          data: logsToSave.map((log) => ({
            projectId: event.data.projectId,
            messageId: message.id,
            source: log.source === "server" ? "SERVER" : "AGENT",
            level: log.level === "info" ? "INFO"
              : log.level === "warn" ? "WARN"
              : log.level === "error" ? "ERROR"
              : "DEBUG",
            content: log.content,
            metadata: log.metadata ?? undefined,
            timestamp: new Date(log.timestamp),
          })),
        });
      }

      return message;
    });
```

- [ ] **Step 9: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 10: Commit**

```bash
git add src/inngest/functions.ts
git commit -m "feat: publish logs to Redis from Inngest agent function"
```

---

## Task 6: SSE Endpoint

**Files:**
- Create: `src/app/api/logs/stream/route.ts`

- [ ] **Step 1: Create SSE route handler**

Create `src/app/api/logs/stream/route.ts`:

```typescript
import { auth } from "@clerk/nextjs/server";
import { NextRequest } from "next/server";

import { prisma } from "@/lib/db";
import { createRedisSubscriber } from "@/lib/redis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) {
    return new Response("Unauthorized", { status: 401 });
  }

  const projectId = req.nextUrl.searchParams.get("projectId");
  if (!projectId) {
    return new Response("Missing projectId", { status: 400 });
  }

  const project = await prisma.project.findUnique({
    where: { id: projectId, userId },
  });
  if (!project) {
    return new Response("Project not found", { status: 404 });
  }

  const user = await prisma.user.findUnique({
    where: { clerkId: userId },
  });
  const isAdmin = user?.isAdmin ?? false;

  const subscriber = createRedisSubscriber();
  await subscriber.connect();

  const channel = `logs:${projectId}`;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const sendEvent = (event: string, data: string) => {
        controller.enqueue(
          encoder.encode(`event: ${event}\nid: ${Date.now()}\ndata: ${data}\n\n`)
        );
      };

      sendEvent("connected", JSON.stringify({ projectId, isAdmin }));

      const heartbeat = setInterval(() => {
        try {
          sendEvent("heartbeat", JSON.stringify({ timestamp: new Date().toISOString() }));
        } catch {
          clearInterval(heartbeat);
        }
      }, 30_000);

      subscriber.on("message", (_channel: string, message: string) => {
        try {
          const parsed = JSON.parse(message);
          if (parsed.source === "agent" && !isAdmin) {
            return;
          }
          sendEvent("log", message);
        } catch {
          // skip malformed messages
        }
      });

      await subscriber.subscribe(channel);

      req.signal.addEventListener("abort", () => {
        clearInterval(heartbeat);
        subscriber.unsubscribe(channel).catch(() => {});
        subscriber.disconnect();
      });
    },
    cancel() {
      subscriber.unsubscribe(channel).catch(() => {});
      subscriber.disconnect();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/logs/stream/route.ts
git commit -m "feat: add SSE endpoint for real-time log streaming"
```

---

## Task 7: tRPC Logs Router (Persisted Log History)

**Files:**
- Create: `src/modules/logs/server/procedures.ts`
- Modify: `src/trpc/routers/_app.ts`

- [ ] **Step 1: Create logs tRPC router**

Create `src/modules/logs/server/procedures.ts`:

```typescript
import { z } from "zod";

import { prisma } from "@/lib/db";
import { protectedProcedure, createTRPCRouter } from "@/trpc/init";

export const logsRouter = createTRPCRouter({
  getByProject: protectedProcedure
    .input(
      z.object({
        projectId: z.string().min(1),
        limit: z.number().min(1).max(200).default(100),
      })
    )
    .query(async ({ input, ctx }) => {
      const logs = await prisma.log.findMany({
        where: {
          projectId: input.projectId,
          project: {
            userId: ctx.auth.userId,
          },
        },
        orderBy: {
          timestamp: "asc",
        },
        take: input.limit,
      });

      return logs;
    }),
});
```

- [ ] **Step 2: Register logs router in app router**

Modify `src/trpc/routers/_app.ts`:

```typescript
import { logsRouter } from '@/modules/logs/server/procedures';
import { usageRouter } from '@/modules/usage/server/procedures';
import { messagesRouter } from '@/modules/messages/server/procedures';
import { projectsRouter } from '@/modules/projects/server/procedures';

import { createTRPCRouter } from '../init';

export const appRouter = createTRPCRouter({
  logs: logsRouter,
  usage: usageRouter,
  messages: messagesRouter,
  projects: projectsRouter,
});
// export type definition of API
export type AppRouter = typeof appRouter;
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add src/modules/logs/server/procedures.ts src/trpc/routers/_app.ts
git commit -m "feat: add tRPC logs router for persisted log history"
```

---

## Task 8: Client Hook — useLogStream

**Files:**
- Create: `src/hooks/use-log-stream.ts`

- [ ] **Step 1: Create the EventSource hook**

Create `src/hooks/use-log-stream.ts`:

```typescript
"use client";

import { useEffect, useRef, useCallback, useState } from "react";

export interface LogEntry {
  id: string;
  source: "server" | "agent";
  level: "info" | "warn" | "error" | "debug";
  content: string;
  metadata?: Record<string, unknown> | null;
  timestamp: string;
}

const MAX_LOGS = 1000;

export function useLogStream(projectId: string) {
  const [serverLogs, setServerLogs] = useState<LogEntry[]>([]);
  const [agentLogs, setAgentLogs] = useState<LogEntry[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!projectId) return;

    const es = new EventSource(`/api/logs/stream?projectId=${projectId}`);
    eventSourceRef.current = es;

    es.addEventListener("connected", (e) => {
      const data = JSON.parse(e.data);
      setIsConnected(true);
      setIsAdmin(data.isAdmin);
    });

    es.addEventListener("log", (e) => {
      const entry: LogEntry = JSON.parse(e.data);

      if (entry.source === "server") {
        setServerLogs((prev) => {
          const next = [...prev, entry];
          return next.length > MAX_LOGS ? next.slice(-MAX_LOGS) : next;
        });
      } else {
        setAgentLogs((prev) => {
          const next = [...prev, entry];
          return next.length > MAX_LOGS ? next.slice(-MAX_LOGS) : next;
        });
      }
    });

    es.addEventListener("heartbeat", () => {
      setIsConnected(true);
    });

    es.onerror = () => {
      setIsConnected(false);
    };

    return () => {
      es.close();
      eventSourceRef.current = null;
      setIsConnected(false);
    };
  }, [projectId]);

  const clearLogs = useCallback(() => {
    setServerLogs([]);
    setAgentLogs([]);
  }, []);

  return { serverLogs, agentLogs, isConnected, isAdmin, clearLogs };
}
```

- [ ] **Step 2: Commit**

```bash
git add src/hooks/use-log-stream.ts
git commit -m "feat: add useLogStream hook for SSE log streaming"
```

---

## Task 9: Client Hook — useConsoleCapture

**Files:**
- Create: `src/hooks/use-console-capture.ts`

- [ ] **Step 1: Create the postMessage listener hook**

Create `src/hooks/use-console-capture.ts`:

```typescript
"use client";

import { useEffect, useCallback, useState } from "react";

export interface ConsoleEntry {
  id: string;
  level: "log" | "warn" | "error" | "info" | "debug";
  args: string[];
  timestamp: string;
}

const MAX_ENTRIES = 500;

let consoleIdCounter = 0;

export function useConsoleCapture() {
  const [consoleLogs, setConsoleLogs] = useState<ConsoleEntry[]>([]);

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (
        !event.data ||
        typeof event.data !== "object" ||
        event.data.type !== "console-log"
      ) {
        return;
      }

      const entry: ConsoleEntry = {
        id: `console-${++consoleIdCounter}`,
        level: event.data.level,
        args: event.data.args,
        timestamp: event.data.timestamp,
      };

      setConsoleLogs((prev) => {
        const next = [...prev, entry];
        return next.length > MAX_ENTRIES ? next.slice(-MAX_ENTRIES) : next;
      });
    };

    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  const clearConsoleLogs = useCallback(() => {
    setConsoleLogs([]);
  }, []);

  return { consoleLogs, clearConsoleLogs };
}
```

- [ ] **Step 2: Commit**

```bash
git add src/hooks/use-console-capture.ts
git commit -m "feat: add useConsoleCapture hook for iframe console logs"
```

---

## Task 10: Log Viewer Component

**Files:**
- Create: `src/modules/projects/ui/components/log-viewer.tsx`

- [ ] **Step 1: Create the shared log viewer**

Create `src/modules/projects/ui/components/log-viewer.tsx`:

```tsx
"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

interface LogItem {
  id: string;
  level: string;
  content?: string;
  args?: string[];
  timestamp: string;
  metadata?: Record<string, unknown> | null;
}

interface Props {
  logs: LogItem[];
  variant?: "server" | "console" | "agent";
}

const levelColors: Record<string, string> = {
  info: "text-blue-400",
  log: "text-blue-400",
  warn: "text-yellow-400",
  error: "text-red-400",
  debug: "text-muted-foreground",
};

const levelDots: Record<string, string> = {
  info: "bg-blue-400",
  log: "bg-blue-400",
  warn: "bg-yellow-400",
  error: "bg-red-400",
  debug: "bg-muted-foreground",
};

const agentBadgeColors: Record<string, string> = {
  tool: "bg-purple-500/15 text-purple-400",
  cmd: "bg-blue-500/15 text-blue-400",
  verify: "bg-yellow-500/15 text-yellow-400",
  lifecycle: "bg-green-500/15 text-green-400",
};

function formatTime(timestamp: string): string {
  try {
    return new Date(timestamp).toLocaleTimeString("en-US", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return "";
  }
}

export function LogViewer({ logs, variant = "server" }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const shouldAutoScroll = useRef(true);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !shouldAutoScroll.current) return;
    container.scrollTop = container.scrollHeight;
  }, [logs]);

  const handleScroll = () => {
    const container = containerRef.current;
    if (!container) return;
    const { scrollTop, scrollHeight, clientHeight } = container;
    shouldAutoScroll.current = scrollHeight - scrollTop - clientHeight < 50;
  };

  if (logs.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
        No logs yet...
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      className="flex-1 overflow-y-auto p-2 font-mono text-xs leading-relaxed"
    >
      {logs.map((log) => (
        <div key={log.id} className="flex gap-2 py-0.5 hover:bg-muted/30">
          <span className="text-muted-foreground shrink-0">
            {formatTime(log.timestamp)}
          </span>

          {variant === "agent" && log.metadata?.type && (
            <span
              className={cn(
                "shrink-0 rounded px-1 text-[10px] font-medium uppercase",
                agentBadgeColors[log.metadata.type as string] ??
                  "bg-muted text-muted-foreground"
              )}
            >
              {log.metadata.type as string}
            </span>
          )}

          {variant !== "agent" && (
            <span
              className={cn(
                "mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full",
                levelDots[log.level] ?? levelDots.info
              )}
            />
          )}

          <span
            className={cn(
              "break-all",
              variant === "agent"
                ? "text-muted-foreground"
                : levelColors[log.level] ?? "text-muted-foreground"
            )}
          >
            {log.content ?? log.args?.join(" ") ?? ""}
          </span>

          {variant === "agent" && log.metadata?.files && (
            <span className="text-muted-foreground text-[10px]">
              {(log.metadata.files as string[]).join(", ")}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/modules/projects/ui/components/log-viewer.tsx
git commit -m "feat: add LogViewer shared component"
```

---

## Task 11: Logs Panel Component

**Files:**
- Create: `src/modules/projects/ui/components/logs-panel.tsx`

- [ ] **Step 1: Create the logs panel with resizable split**

Create `src/modules/projects/ui/components/logs-panel.tsx`:

```tsx
"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FilterIcon, Trash2Icon } from "lucide-react";

import { cn } from "@/lib/utils";
import { useTRPC } from "@/trpc/client";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";

import { LogViewer } from "./log-viewer";
import { useLogStream, type LogEntry } from "@/hooks/use-log-stream";
import {
  useConsoleCapture,
  type ConsoleEntry,
} from "@/hooks/use-console-capture";

interface Props {
  projectId: string;
}

function filterLogs<T extends { content?: string; args?: string[]; level: string }>(
  logs: T[],
  filter: string
): T[] {
  if (!filter) return logs;
  const lower = filter.toLowerCase();
  return logs.filter((log) => {
    const text = log.content ?? log.args?.join(" ") ?? "";
    return text.toLowerCase().includes(lower) || log.level.includes(lower);
  });
}

function StatusBar({
  isConnected,
  count,
  filter,
  onFilterChange,
  onClear,
}: {
  isConnected: boolean;
  count: number;
  filter: string;
  onFilterChange: (v: string) => void;
  onClear: () => void;
}) {
  const [showFilter, setShowFilter] = useState(false);

  return (
    <div className="flex items-center gap-2 border-t px-2 py-1 text-[10px]">
      <span
        className={cn(
          "flex items-center gap-1",
          isConnected ? "text-green-500" : "text-muted-foreground"
        )}
      >
        <span
          className={cn(
            "h-1.5 w-1.5 rounded-full",
            isConnected ? "bg-green-500" : "bg-muted-foreground"
          )}
        />
        {isConnected ? "Live" : "Disconnected"}
      </span>
      <span className="text-muted-foreground">{count} entries</span>
      <div className="ml-auto flex items-center gap-1">
        {showFilter && (
          <Input
            value={filter}
            onChange={(e) => onFilterChange(e.target.value)}
            placeholder="Filter..."
            className="h-5 w-32 text-[10px] px-1"
          />
        )}
        <Button
          variant="ghost"
          size="icon"
          className="h-5 w-5"
          onClick={() => setShowFilter(!showFilter)}
        >
          <FilterIcon className="h-3 w-3" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-5 w-5"
          onClick={onClear}
        >
          <Trash2Icon className="h-3 w-3" />
        </Button>
      </div>
    </div>
  );
}

export function LogsPanel({ projectId }: Props) {
  const trpc = useTRPC();
  const { serverLogs, agentLogs, isConnected, isAdmin, clearLogs } =
    useLogStream(projectId);
  const { consoleLogs, clearConsoleLogs } = useConsoleCapture();
  const { data: historicalLogs } = useQuery(
    trpc.logs.getByProject.queryOptions({ projectId })
  );

  // Merge historical logs (from DB) with live logs (from SSE)
  const mergedServerLogs = useMemo(() => {
    const historical = (historicalLogs ?? [])
      .filter((l) => l.source === "SERVER")
      .map((l) => ({
        id: l.id,
        source: "server" as const,
        level: l.level.toLowerCase() as LogEntry["level"],
        content: l.content,
        metadata: l.metadata as Record<string, unknown> | null,
        timestamp: new Date(l.timestamp).toISOString(),
      }));
    return [...historical, ...serverLogs];
  }, [historicalLogs, serverLogs]);

  const mergedAgentLogs = useMemo(() => {
    const historical = (historicalLogs ?? [])
      .filter((l) => l.source === "AGENT")
      .map((l) => ({
        id: l.id,
        source: "agent" as const,
        level: l.level.toLowerCase() as LogEntry["level"],
        content: l.content,
        metadata: l.metadata as Record<string, unknown> | null,
        timestamp: new Date(l.timestamp).toISOString(),
      }));
    return [...historical, ...agentLogs];
  }, [historicalLogs, agentLogs]);

  const [serverFilter, setServerFilter] = useState("");
  const [consoleFilter, setConsoleFilter] = useState("");
  const [agentFilter, setAgentFilter] = useState("");

  const filteredServerLogs = filterLogs(mergedServerLogs, serverFilter);
  const filteredConsoleLogs = filterLogs(consoleLogs, consoleFilter);
  const filteredAgentLogs = filterLogs(mergedAgentLogs, agentFilter);

  const leftPanel = (
    <div className="flex h-full flex-col">
      <Tabs defaultValue="server" className="flex h-full flex-col gap-0">
        <TabsList className="h-8 w-full justify-start rounded-none border-b bg-transparent p-0 px-2">
          <TabsTrigger
            value="server"
            className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none"
          >
            Server
          </TabsTrigger>
          <TabsTrigger
            value="console"
            className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none"
          >
            Console
          </TabsTrigger>
        </TabsList>
        <TabsContent value="server" className="flex-1 flex flex-col mt-0 min-h-0">
          <LogViewer logs={filteredServerLogs} variant="server" />
          <StatusBar
            isConnected={isConnected}
            count={filteredServerLogs.length}
            filter={serverFilter}
            onFilterChange={setServerFilter}
            onClear={clearLogs}
          />
        </TabsContent>
        <TabsContent value="console" className="flex-1 flex flex-col mt-0 min-h-0">
          <LogViewer logs={filteredConsoleLogs} variant="console" />
          <StatusBar
            isConnected={true}
            count={filteredConsoleLogs.length}
            filter={consoleFilter}
            onFilterChange={setConsoleFilter}
            onClear={clearConsoleLogs}
          />
        </TabsContent>
      </Tabs>
    </div>
  );

  if (!isAdmin) {
    return <div className="h-full flex flex-col">{leftPanel}</div>;
  }

  return (
    <ResizablePanelGroup direction="horizontal" className="h-full">
      <ResizablePanel defaultSize={62} minSize={30}>
        {leftPanel}
      </ResizablePanel>
      <ResizableHandle className="hover:bg-primary transition-colors" />
      <ResizablePanel defaultSize={38} minSize={20}>
        <div className="flex h-full flex-col">
          <div className="flex items-center gap-2 border-b px-3 py-1.5">
            <span className="text-sm font-semibold text-purple-400">
              Agent Logs
            </span>
            <span className="rounded bg-purple-500/20 px-1.5 py-0.5 text-[9px] font-medium text-purple-400">
              ADMIN
            </span>
          </div>
          <LogViewer logs={filteredAgentLogs} variant="agent" />
          <StatusBar
            isConnected={isConnected}
            count={filteredAgentLogs.length}
            filter={agentFilter}
            onFilterChange={setAgentFilter}
            onClear={clearLogs}
          />
        </div>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/modules/projects/ui/components/logs-panel.tsx
git commit -m "feat: add LogsPanel with resizable split and sub-tabs"
```

---

## Task 12: Wire Logs Tab into Project View

**Files:**
- Modify: `src/modules/projects/ui/views/project-view.tsx`

- [ ] **Step 1: Add imports**

Add at the top of `project-view.tsx`, after the existing imports:

```typescript
import { TerminalSquareIcon } from "lucide-react";
import { LogsPanel } from "../components/logs-panel";
```

- [ ] **Step 2: Expand tab state type**

Change the `useState` line:

```typescript
  const [tabState, setTabState] = useState<"preview" | "code" | "logs">("preview");
```

And update the `onValueChange` cast:

```typescript
onValueChange={(value) => setTabState(value as "preview" | "code" | "logs")}
```

- [ ] **Step 3: Add Logs tab trigger**

After the Code `TabsTrigger` (after the closing `</TabsTrigger>` for "code"), add:

```tsx
                <TabsTrigger value="logs" className="rounded-md">
                  <TerminalSquareIcon /> <span>Logs</span>
                </TabsTrigger>
```

- [ ] **Step 4: Add Logs tab content**

After the Code `TabsContent` (after the closing `</TabsContent>` for "code"), add:

```tsx
            <TabsContent value="logs" className="min-h-0">
              <LogsPanel projectId={projectId} />
            </TabsContent>
```

- [ ] **Step 5: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add src/modules/projects/ui/views/project-view.tsx
git commit -m "feat: add Logs tab to project view"
```

---

## Task 13: Console Capture Script in Sandbox Template

**Files:**
- Modify: `sandbox-templates/nextjs/template.ts`

- [ ] **Step 1: Add console capture script to sandbox template**

The sandbox template uses `compile_page.sh` to start the dev server and the `template.ts` to build the e2b image. We need to inject a script into the Next.js app's root layout.

The cleanest approach: create a file that gets copied into the sandbox and injected into the `<head>` via the root layout.

First, create the console capture script file. Create `sandbox-templates/nextjs/console-capture.js`:

```javascript
(function() {
  if (typeof window === 'undefined' || !window.parent || window.parent === window) return;

  var methods = ['log', 'warn', 'error', 'info', 'debug'];
  var originals = {};

  function safeStringify(obj) {
    var seen = new WeakSet();
    return JSON.stringify(obj, function(key, value) {
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) return '[Circular]';
        seen.add(value);
      }
      if (value instanceof Error) {
        return { message: value.message, stack: value.stack };
      }
      if (typeof value === 'function') return '[Function: ' + (value.name || 'anonymous') + ']';
      if (typeof value === 'undefined') return '[undefined]';
      return value;
    });
  }

  methods.forEach(function(method) {
    originals[method] = console[method];
    console[method] = function() {
      originals[method].apply(console, arguments);
      try {
        var args = Array.prototype.slice.call(arguments).map(function(arg) {
          if (typeof arg === 'string') return arg;
          try { return safeStringify(arg); }
          catch(e) { return String(arg); }
        });
        window.parent.postMessage({
          type: 'console-log',
          level: method,
          args: args,
          timestamp: new Date().toISOString()
        }, '*');
      } catch(e) {}
    };
  });

  window.onerror = function(message, source, lineno, colno, error) {
    try {
      window.parent.postMessage({
        type: 'console-log',
        level: 'error',
        args: ['Uncaught Error: ' + message + ' at ' + source + ':' + lineno + ':' + colno],
        timestamp: new Date().toISOString()
      }, '*');
    } catch(e) {}
  };

  window.addEventListener('unhandledrejection', function(event) {
    try {
      var reason = event.reason;
      var msg = reason instanceof Error ? reason.message : String(reason);
      window.parent.postMessage({
        type: 'console-log',
        level: 'error',
        args: ['Unhandled Promise Rejection: ' + msg],
        timestamp: new Date().toISOString()
      }, '*');
    } catch(e) {}
  });
})();
```

- [ ] **Step 2: Add the script file to the sandbox template**

Modify `sandbox-templates/nextjs/template.ts` to copy the console capture script into the sandbox. Add before the final `.setUser('user')` line:

```typescript
  .copy('console-capture.js', '/home/user/public/console-capture.js')
```

The full updated template:

```typescript
import { Template } from 'e2b'

export const template = Template()
  .fromImage('node:22-slim')
  .setUser('root')
  .setWorkdir('/')
  .runCmd('apt-get update && apt-get install -y curl && apt-get clean && rm -rf /var/lib/apt/lists/*')
  .copy('compile_page.sh', '/compile_page.sh')
  .runCmd('chmod +x /compile_page.sh')
  .setWorkdir('/home/user/nextjs-app')
  .runCmd('npx --yes create-next-app@16.2.1 . --yes --no-src-dir')
  .runCmd('npx --yes shadcn@4.1.1 init --defaults --force')
  .runCmd('npx --yes shadcn@4.1.1 add --all --yes')
  .runCmd('npm install tw-animate-css')
  .runCmd('mkdir -p app/api/health')
  .copy('health-route.ts', '/home/user/nextjs-app/app/api/health/route.ts')
  .copy('global-error.tsx', '/home/user/nextjs-app/app/global-error.tsx')
  .copy('console-capture.js', '/home/user/nextjs-app/public/console-capture.js')
  .runCmd('npm install')
  .runCmd('cp -rT /home/user/nextjs-app /home/user && rm -rf /home/user/nextjs-app')
  .setWorkdir('/home/user')
  .setUser('user')
  .setStartCmd('sudo /compile_page.sh', 'sleep 20')
```

- [ ] **Step 3: Update the agent prompt to include the script in layouts**

The agent generates the root layout for each project. We need to tell the agent to include the console capture script. Open `src/prompt.ts` and add to the `PROMPT` template string, in the section that describes file rules/layout requirements:

```
IMPORTANT: Always include this script tag in the <head> of app/layout.tsx:
<Script src="/console-capture.js" strategy="beforeInteractive" />
Import Script from 'next/script' at the top of the layout file.
```

This instructs the code agent to always include the console capture script when generating layouts.

- [ ] **Step 4: Commit**

```bash
git add sandbox-templates/nextjs/console-capture.js sandbox-templates/nextjs/template.ts src/prompt.ts
git commit -m "feat: add console capture script to sandbox template"
```

---

## Task 14: Server Log Streaming from Dev Server Process

**Files:**
- Modify: `src/inngest/functions.ts`

The dev server runs via `compile_page.sh` as the sandbox start command. Its stdout/stderr go to `/tmp/nextjs-dev.log`. To stream these logs in real-time, we need to tail this file using the e2b SDK's background command feature.

- [ ] **Step 1: Add dev server log tailing after sandbox is acquired**

After the `get-sandbox-id` step and before `get-previous-messages`, add a new step that starts tailing the dev server log in the background:

```typescript
    await step.run("start-log-tail", async () => {
      try {
        const sandbox = await getSandbox(sandboxId);
        await sandbox.commands.run(
          "tail -f /tmp/nextjs-dev.log 2>/dev/null",
          {
            background: true,
            timeoutMs: 0,
            onStdout: (data: string) => {
              const line = data.trim();
              if (!line) return;

              let level: "info" | "warn" | "error" = "info";
              if (line.includes("warn") || line.includes("Warning")) level = "warn";
              if (line.includes("error") || line.includes("Error") || line.includes("ERR")) level = "error";

              publishLog(event.data.projectId, {
                source: "server",
                level,
                content: line,
              }, logBuffer);
            },
            onStderr: (data: string) => {
              const line = data.trim();
              if (!line) return;
              publishLog(event.data.projectId, {
                source: "server",
                level: "error",
                content: line,
              }, logBuffer);
            },
          }
        );
      } catch {
        // Dev server log not available yet — non-critical
      }
    });
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/inngest/functions.ts
git commit -m "feat: tail dev server logs and publish to Redis"
```

---

## Task 15: Integration Verification

**Files:** None (verification only)

- [ ] **Step 1: Verify all TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: No errors.

- [ ] **Step 2: Verify Prisma generates**

```bash
npx prisma generate
```

Expected: Prisma client generated with User, Log, LogSource, LogLevel types.

- [ ] **Step 3: Verify dev server starts**

```bash
npm run dev
```

Expected: Dev server starts without import/compilation errors. Verify in browser that the Logs tab appears.

- [ ] **Step 4: Run a quick manual smoke test**

1. Open a project page
2. Verify three tabs appear: Demo, Code, Logs
3. Click Logs tab — should show "No logs yet..." with Server/Console sub-tabs
4. If you have Redis running locally, verify SSE connection establishes (green "Live" indicator)
5. Send a message to trigger the agent — logs should stream in real-time

- [ ] **Step 5: Final commit if any fixes were needed**

```bash
git add -A
git commit -m "fix: integration fixes for logs tab"
```
