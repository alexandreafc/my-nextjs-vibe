# Multi-Provider Model Selector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow admins to configure multiple OpenAI-compatible LLM providers (LiteLLM, OpenRouter, Ollama, etc.) and let users choose which model to use per message in the chat.

**Architecture:** Database-driven provider config (Provider + Model tables) with encrypted API keys. The Inngest agent function reads provider config at runtime and creates an OpenAI-compatible client dynamically — the `@inngest/agent-kit` `openai()` function accepts `baseUrl` and `apiKey` to point at any OpenAI-compatible endpoint. A settings page (admin-only) manages providers and models; a dropdown in the chat form lets users pick a model per message.

**Tech Stack:** Next.js 15, Prisma (PostgreSQL), tRPC v11, Inngest + agent-kit, Clerk auth, Shadcn/UI (Select, Dialog, Switch already installed), React Hook Form, Zod.

---

## File Map

### New files
| File | Purpose |
|------|---------|
| `src/lib/crypto.ts` | AES-256-GCM encrypt/decrypt for API keys |
| `src/lib/create-model-client.ts` | Factory: resolves modelId → `{ primary, mini, apiKey }` |
| `src/components/user-sync.tsx` | Client component that upserts User record on mount |
| `src/modules/users/server/procedures.ts` | `users.syncCurrent` tRPC mutation |
| `src/modules/providers/server/procedures.ts` | `providers.*` tRPC router (admin only) |
| `src/modules/models/server/procedures.ts` | `models.*` tRPC router |
| `src/app/settings/page.tsx` | Server component — admin gate + renders SettingsView |
| `src/modules/settings/ui/views/settings-view.tsx` | Client view with providers table |
| `src/modules/settings/ui/components/provider-form-modal.tsx` | Add/edit provider + discover models |
| `src/modules/settings/ui/components/models-list.tsx` | Per-provider model list with toggle/delete |

### Modified files
| File | Change |
|------|--------|
| `.env` | Add `ENCRYPTION_KEY` |
| `prisma/schema.prisma` | Add `User`, `Provider`, `Model`; add `modelId` to `Message` |
| `src/trpc/init.ts` | Export `adminProcedure` |
| `src/trpc/routers/_app.ts` | Register `providers`, `models`, `users` routers |
| `src/inngest/functions.ts` | Use `createModelClient` for all 4 agents |
| `src/app/layout.tsx` | Add `<UserSync />` for authenticated users |
| `src/modules/messages/server/procedures.ts` | Add `modelId` to `create` input + Inngest event |
| `src/modules/projects/ui/components/message-form.tsx` | Add model dropdown |

---

## Task 1: ENCRYPTION_KEY + crypto utility

**Files:**
- Modify: `.env`
- Create: `src/lib/crypto.ts`

- [ ] **Step 1: Generate a 32-byte hex key and add to .env**

Run this to generate the key:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Add to `.env` (replace `<output>` with the generated value):
```
ENCRYPTION_KEY="<output>"
```

- [ ] **Step 2: Create `src/lib/crypto.ts`**

```ts
import { createCipheriv, createDecipheriv, randomBytes } from "crypto"

function getKey(): Buffer {
  const key = process.env.ENCRYPTION_KEY
  if (!key) throw new Error("ENCRYPTION_KEY env var is not set")
  return Buffer.from(key, "hex")
}

export function encrypt(text: string): string {
  const iv = randomBytes(12) // 96-bit IV for AES-GCM
  const cipher = createCipheriv("aes-256-gcm", getKey(), iv)
  const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()])
  const authTag = cipher.getAuthTag()
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`
}

export function decrypt(stored: string): string {
  const [ivHex, authTagHex, encryptedHex] = stored.split(":")
  const decipher = createDecipheriv(
    "aes-256-gcm",
    getKey(),
    Buffer.from(ivHex, "hex")
  )
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"))
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedHex, "hex")),
    decipher.final(),
  ]).toString("utf8")
}
```

- [ ] **Step 3: Verify encrypt/decrypt round-trips**

Run in a `node` REPL (from project root, with `.env` loaded):
```bash
node -e "
require('dotenv').config();
const { encrypt, decrypt } = require('./src/lib/crypto.ts');
"
```
If it errors on `.ts` import, use `tsx`:
```bash
npx tsx -e "
import 'dotenv/config';
import { encrypt, decrypt } from './src/lib/crypto.ts';
const enc = encrypt('my-api-key');
console.log('encrypted:', enc);
console.log('decrypted:', decrypt(enc));
"
```
Expected output: `decrypted: my-api-key`

- [ ] **Step 4: Commit**

```bash
git add .env src/lib/crypto.ts
git commit -m "feat: add AES-256-GCM encryption utility for API keys"
```

---

## Task 2: Prisma schema — add User, Provider, Model tables

**Files:**
- Modify: `prisma/schema.prisma`

- [ ] **Step 1: Add new models to `prisma/schema.prisma`**

After the existing `Usage` model, append:

```prisma
model User {
  id        String   @id @default(cuid())
  clerkId   String   @unique
  email     String
  isAdmin   Boolean  @default(false)
  createdAt DateTime @default(now())
}

model Provider {
  id        String   @id @default(cuid())
  name      String
  baseUrl   String
  apiKeyEnc String
  isActive  Boolean  @default(true)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  models    Model[]
}

model Model {
  id               String    @id @default(cuid())
  providerId       String
  provider         Provider  @relation(fields: [providerId], references: [id], onDelete: Cascade)
  name             String
  displayName      String
  isActive         Boolean   @default(true)
  isAutoDiscovered Boolean   @default(false)
  createdAt        DateTime  @default(now())
  messages         Message[]
}
```

- [ ] **Step 2: Add `modelId` to the existing `Message` model**

In the `Message` model block, after the `fragment Fragment?` line, add:

```prisma
  modelId   String?
  model     Model?   @relation(fields: [modelId], references: [id])
```

The full `Message` model should now be:
```prisma
model Message {
  id        String      @id @default(uuid())
  content   String
  role      MessageRole
  type      MessageType
  createdAt DateTime    @default(now())
  updatedAt DateTime    @updatedAt

  projectId String
  project   Project  @relation(fields: [projectId], references: [id], onDelete: Cascade)

  fragment  Fragment?

  modelId   String?
  model     Model?   @relation(fields: [modelId], references: [id])
}
```

- [ ] **Step 3: Run migration**

```bash
npx prisma migrate dev --name multi-provider
```

Expected output: `✔ Generated Prisma Client` and migration file created in `prisma/migrations/`.

- [ ] **Step 4: Verify migration applied**

```bash
npx prisma studio
```

Open `http://localhost:5555` — verify `User`, `Provider`, `Model` tables exist and `Message` has `modelId` column.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/
git commit -m "feat: add User, Provider, Model tables and Message.modelId"
```

---

## Task 3: createModelClient utility

**Files:**
- Create: `src/lib/create-model-client.ts`

- [ ] **Step 1: Create `src/lib/create-model-client.ts`**

```ts
import { prisma } from "@/lib/db"
import { decrypt } from "@/lib/crypto"

export interface ModelClientConfig {
  primary: { model: string; baseUrl: string | undefined }
  mini: { model: string; baseUrl: string | undefined }
  apiKey: string | undefined
}

export async function createModelClient(modelId?: string): Promise<ModelClientConfig> {
  if (!modelId) {
    return {
      primary: {
        model: process.env.OPENAI_MODEL ?? "gpt-5.4",
        baseUrl: process.env.OPENAI_BASE_URL,
      },
      mini: {
        model: process.env.OPENAI_MODEL_MINI ?? "gpt-5.4-mini",
        baseUrl: process.env.OPENAI_BASE_URL,
      },
      apiKey: process.env.OPENAI_API_KEY,
    }
  }

  const record = await prisma.model.findUniqueOrThrow({
    where: { id: modelId },
    include: { provider: true },
  })

  const apiKey = decrypt(record.provider.apiKeyEnc)

  return {
    primary: {
      model: record.name,
      baseUrl: record.provider.baseUrl,
    },
    mini: {
      model: process.env.OPENAI_MODEL_MINI ?? record.name,
      baseUrl: record.provider.baseUrl,
    },
    apiKey,
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/create-model-client.ts
git commit -m "feat: add createModelClient utility for dynamic provider resolution"
```

---

## Task 4: Add adminProcedure to tRPC init

**Files:**
- Modify: `src/trpc/init.ts`

- [ ] **Step 1: Add `adminProcedure` export to `src/trpc/init.ts`**

After the existing `isAuthed` middleware and `protectedProcedure` export, add:

```ts
import { prisma } from "@/lib/db";

const isAdmin = t.middleware(async ({ next, ctx }) => {
  if (!ctx.auth.userId) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Not authenticated" });
  }

  const user = await prisma.user.findUnique({
    where: { clerkId: ctx.auth.userId },
  });

  if (!user?.isAdmin) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Admin access required" });
  }

  return next({ ctx });
});

export const adminProcedure = t.procedure.use(isAdmin);
```

The complete file (`src/trpc/init.ts`) should now be:

```ts
import { auth } from '@clerk/nextjs/server';
import { initTRPC, TRPCError } from '@trpc/server';
import { cache } from 'react';
import superjson from "superjson";

import { prisma } from "@/lib/db";

export const createTRPCContext = cache(async () => {
  const authData = await auth();
  return { auth: authData };
});
export type Context = Awaited<ReturnType<typeof createTRPCContext>>;

const t = initTRPC.context<Context>().create({
  transformer: superjson,
});

const isAuthed = t.middleware(({ next, ctx }) => {
  if (!ctx.auth.userId) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Not authenticated",
    });
  }
  return next({ ctx: { auth: ctx.auth } });
});

const isAdmin = t.middleware(async ({ next, ctx }) => {
  if (!ctx.auth.userId) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Not authenticated" });
  }
  const user = await prisma.user.findUnique({
    where: { clerkId: ctx.auth.userId },
  });
  if (!user?.isAdmin) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Admin access required" });
  }
  return next({ ctx });
});

export const createTRPCRouter = t.router;
export const createCallerFactory = t.createCallerFactory;
export const baseProcedure = t.procedure;
export const protectedProcedure = t.procedure.use(isAuthed);
export const adminProcedure = t.procedure.use(isAdmin);
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/trpc/init.ts
git commit -m "feat: add adminProcedure middleware with isAdmin DB check"
```

---

## Task 5: Users tRPC router + UserSync component

**Files:**
- Create: `src/modules/users/server/procedures.ts`
- Create: `src/components/user-sync.tsx`
- Modify: `src/app/layout.tsx`

- [ ] **Step 1: Create `src/modules/users/server/procedures.ts`**

```ts
import { currentUser } from "@clerk/nextjs/server";
import { prisma } from "@/lib/db";
import { protectedProcedure, createTRPCRouter } from "@/trpc/init";

export const usersRouter = createTRPCRouter({
  syncCurrent: protectedProcedure
    .mutation(async ({ ctx }) => {
      const clerkUser = await currentUser();
      const email = clerkUser?.emailAddresses[0]?.emailAddress ?? "";

      return await prisma.user.upsert({
        where: { clerkId: ctx.auth.userId! },
        create: {
          clerkId: ctx.auth.userId!,
          email,
          isAdmin: false,
        },
        update: { email },
        select: { isAdmin: true },
      });
    }),
});
```

- [ ] **Step 2: Create `src/components/user-sync.tsx`**

```tsx
"use client";

import { useEffect } from "react";
import { useUser } from "@clerk/nextjs";
import { useMutation } from "@tanstack/react-query";
import { useTRPC } from "@/trpc/client";

export function UserSync() {
  const { isSignedIn } = useUser();
  const trpc = useTRPC();
  const sync = useMutation(trpc.users.syncCurrent.mutationOptions());

  useEffect(() => {
    if (isSignedIn) {
      sync.mutate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSignedIn]);

  return null;
}
```

- [ ] **Step 3: Register the users router in `src/trpc/routers/_app.ts`** (do the full registration in Task 9, but add just users now so UserSync works)

In `src/trpc/routers/_app.ts`:
```ts
import { usageRouter } from '@/modules/usage/server/procedures';
import { messagesRouter } from '@/modules/messages/server/procedures';
import { projectsRouter } from '@/modules/projects/server/procedures';
import { usersRouter } from '@/modules/users/server/procedures';

import { createTRPCRouter } from '../init';

export const appRouter = createTRPCRouter({
  usage: usageRouter,
  messages: messagesRouter,
  projects: projectsRouter,
  users: usersRouter,
});
export type AppRouter = typeof appRouter;
```

- [ ] **Step 4: Add `<UserSync />` to `src/app/layout.tsx`**

```tsx
import type { Metadata } from "next";
import { ThemeProvider } from "next-themes";
import { ClerkProvider, SignedIn } from "@clerk/nextjs";
import { Geist, Geist_Mono } from "next/font/google";

import { Toaster } from "@/components/ui/sonner";
import { TRPCReactProvider } from "@/trpc/client";
import { UserSync } from "@/components/user-sync";

import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Create Next App",
  description: "Generated by create next app",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <ClerkProvider
      appearance={{
        variables: {
          colorPrimary: "#C96342",
        },
      }}
    >
      <TRPCReactProvider>
        <html lang="en" suppressHydrationWarning>
          <body
            className={`${geistSans.variable} ${geistMono.variable} antialiased`}
          >
            <ThemeProvider
              attribute="class"
              defaultTheme="system"
              enableSystem
              disableTransitionOnChange
            >
              <Toaster />
              <SignedIn>
                <UserSync />
              </SignedIn>
              {children}
            </ThemeProvider>
          </body>
        </html>
      </TRPCReactProvider>
    </ClerkProvider>
  );
}
```

- [ ] **Step 5: Verify — sign in and check DB**

Start dev server: `npm run dev`
Sign in. Open Prisma Studio (`npx prisma studio`) and check the `User` table — a record should appear with your clerkId and email.

- [ ] **Step 6: Commit**

```bash
git add src/modules/users/server/procedures.ts src/components/user-sync.tsx src/app/layout.tsx src/trpc/routers/_app.ts
git commit -m "feat: add user sync — upsert User record on sign-in"
```

---

## Task 6: Providers tRPC router

**Files:**
- Create: `src/modules/providers/server/procedures.ts`

- [ ] **Step 1: Create `src/modules/providers/server/procedures.ts`**

```ts
import { z } from "zod";
import { TRPCError } from "@trpc/server";

import { prisma } from "@/lib/db";
import { encrypt, decrypt } from "@/lib/crypto";
import { adminProcedure, createTRPCRouter } from "@/trpc/init";

export const providersRouter = createTRPCRouter({
  list: adminProcedure.query(async () => {
    return await prisma.provider.findMany({
      include: {
        _count: { select: { models: true } },
        models: { orderBy: { createdAt: "asc" } },
      },
      orderBy: { createdAt: "asc" },
    });
  }),

  create: adminProcedure
    .input(
      z.object({
        name: z.string().min(1),
        baseUrl: z.string().url(),
        apiKey: z.string().min(1),
      }),
    )
    .mutation(async ({ input }) => {
      return await prisma.provider.create({
        data: {
          name: input.name,
          baseUrl: input.baseUrl,
          apiKeyEnc: encrypt(input.apiKey),
        },
      });
    }),

  update: adminProcedure
    .input(
      z.object({
        id: z.string().min(1),
        name: z.string().min(1).optional(),
        baseUrl: z.string().url().optional(),
        apiKey: z.string().min(1).optional(),
        isActive: z.boolean().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const { id, apiKey, ...rest } = input;
      return await prisma.provider.update({
        where: { id },
        data: {
          ...rest,
          ...(apiKey ? { apiKeyEnc: encrypt(apiKey) } : {}),
        },
      });
    }),

  delete: adminProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ input }) => {
      return await prisma.provider.delete({ where: { id: input.id } });
    }),

  discoverModels: adminProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const provider = await prisma.provider.findUniqueOrThrow({
        where: { id: input.id },
      });

      const apiKey = decrypt(provider.apiKeyEnc);

      const response = await fetch(`${provider.baseUrl}/models`, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Provider returned ${response.status}: ${await response.text()}`,
        });
      }

      const data = (await response.json()) as { data: Array<{ id: string }> };
      const discoveredIds = data.data.map((m) => m.id);

      const existing = await prisma.model.findMany({
        where: { providerId: input.id },
        select: { name: true },
      });
      const existingNames = new Set(existing.map((m) => m.name));

      const toCreate = discoveredIds.filter((id) => !existingNames.has(id));

      if (toCreate.length > 0) {
        await prisma.model.createMany({
          data: toCreate.map((name) => ({
            providerId: input.id,
            name,
            displayName: name,
            isAutoDiscovered: true,
          })),
        });
      }

      return await prisma.model.findMany({
        where: { providerId: input.id },
        orderBy: { createdAt: "asc" },
      });
    }),
});
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/modules/providers/server/procedures.ts
git commit -m "feat: add providers tRPC router with CRUD and model discovery"
```

---

## Task 7: Models tRPC router

**Files:**
- Create: `src/modules/models/server/procedures.ts`

- [ ] **Step 1: Create `src/modules/models/server/procedures.ts`**

```ts
import { z } from "zod";
import { prisma } from "@/lib/db";
import { adminProcedure, protectedProcedure, createTRPCRouter } from "@/trpc/init";

export const modelsRouter = createTRPCRouter({
  listActive: protectedProcedure.query(async () => {
    return await prisma.model.findMany({
      where: {
        isActive: true,
        provider: { isActive: true },
      },
      include: {
        provider: { select: { name: true } },
      },
      orderBy: [{ provider: { name: "asc" } }, { displayName: "asc" }],
    });
  }),

  create: adminProcedure
    .input(
      z.object({
        providerId: z.string().min(1),
        name: z.string().min(1),
        displayName: z.string().min(1),
      }),
    )
    .mutation(async ({ input }) => {
      return await prisma.model.create({
        data: {
          providerId: input.providerId,
          name: input.name,
          displayName: input.displayName,
          isAutoDiscovered: false,
        },
      });
    }),

  toggleActive: adminProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const model = await prisma.model.findUniqueOrThrow({
        where: { id: input.id },
      });
      return await prisma.model.update({
        where: { id: input.id },
        data: { isActive: !model.isActive },
      });
    }),

  delete: adminProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ input }) => {
      return await prisma.model.delete({ where: { id: input.id } });
    }),
});
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/modules/models/server/procedures.ts
git commit -m "feat: add models tRPC router"
```

---

## Task 8: Update messages router — add modelId

**Files:**
- Modify: `src/modules/messages/server/procedures.ts`

- [ ] **Step 1: Add `modelId` to `create` input schema**

In `src/modules/messages/server/procedures.ts`, update the `create` input:

```ts
// Change this input schema:
z.object({
  value: z.string()
    .min(1, { message: "Value is required" })
    .max(10000, { message: "Value is too long" }),
  projectId: z.string().min(1, { message: "Project ID is required" }),
})

// To this:
z.object({
  value: z.string()
    .min(1, { message: "Value is required" })
    .max(10000, { message: "Value is too long" }),
  projectId: z.string().min(1, { message: "Project ID is required" }),
  modelId: z.string().optional(),
})
```

- [ ] **Step 2: Pass `modelId` when creating the user message**

Change the `prisma.message.create` call:

```ts
// Before:
const createdMessage = await prisma.message.create({
  data: {
    projectId: existingProject.id,
    content: input.value,
    role: "USER",
    type: "RESULT",
  },
});

// After:
const createdMessage = await prisma.message.create({
  data: {
    projectId: existingProject.id,
    content: input.value,
    role: "USER",
    type: "RESULT",
    modelId: input.modelId,
  },
});
```

- [ ] **Step 3: Pass `modelId` in the Inngest event**

Change the `inngest.send` call:

```ts
// Before:
await inngest.send({
  name: "code-agent/run",
  data: {
    value: input.value,
    projectId: input.projectId,
  },
});

// After:
await inngest.send({
  name: "code-agent/run",
  data: {
    value: input.value,
    projectId: input.projectId,
    modelId: input.modelId,
  },
});
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/modules/messages/server/procedures.ts
git commit -m "feat: pass modelId through messages.create to Inngest event"
```

---

## Task 9: Register all new routers in _app.ts

**Files:**
- Modify: `src/trpc/routers/_app.ts`

- [ ] **Step 1: Update `src/trpc/routers/_app.ts`**

```ts
import { usageRouter } from '@/modules/usage/server/procedures';
import { messagesRouter } from '@/modules/messages/server/procedures';
import { projectsRouter } from '@/modules/projects/server/procedures';
import { usersRouter } from '@/modules/users/server/procedures';
import { providersRouter } from '@/modules/providers/server/procedures';
import { modelsRouter } from '@/modules/models/server/procedures';

import { createTRPCRouter } from '../init';

export const appRouter = createTRPCRouter({
  usage: usageRouter,
  messages: messagesRouter,
  projects: projectsRouter,
  users: usersRouter,
  providers: providersRouter,
  models: modelsRouter,
});

export type AppRouter = typeof appRouter;
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/trpc/routers/_app.ts
git commit -m "feat: register providers, models, users routers in app router"
```

---

## Task 10: Update Inngest functions.ts — dynamic model client

**Files:**
- Modify: `src/inngest/functions.ts`

- [ ] **Step 1: Add createModelClient step at the start of the function**

At the top of the file, add the import:
```ts
import { createModelClient } from "@/lib/create-model-client";
```

Inside `codeAgentFunction`, after the `previousMessages` step and before `const state = createState(...)`, add:

```ts
const modelClient = await step.run("get-model-client", async () => {
  return await createModelClient(
    (event.data as { modelId?: string }).modelId
  );
});
```

- [ ] **Step 2: Replace the codeAgent `openai()` call**

Change:
```ts
model: openai({
  model: process.env.OPENAI_MODEL || "gpt-4.1",
  baseUrl: process.env.OPENAI_BASE_URL,
  defaultParameters: {
    temperature: 0.1,
  },
}),
```

To:
```ts
model: openai({
  ...modelClient.primary,
  apiKey: modelClient.apiKey,
  defaultParameters: {
    temperature: 0.1,
  },
}),
```

- [ ] **Step 3: Replace the verifierAgent `openai()` call**

Change:
```ts
model: openai({
  model: process.env.OPENAI_MODEL || "gpt-4.1",
  baseUrl: process.env.OPENAI_BASE_URL,
  defaultParameters: {
    temperature: 0,
  },
}),
```

To:
```ts
model: openai({
  ...modelClient.primary,
  apiKey: modelClient.apiKey,
  defaultParameters: {
    temperature: 0,
  },
}),
```

- [ ] **Step 4: Replace fragmentTitleGenerator `openai()` call**

Change:
```ts
model: openai({
  model: process.env.OPENAI_MODEL_MINI || "gpt-4o",
  baseUrl: process.env.OPENAI_BASE_URL,
}),
```

To:
```ts
model: openai({
  ...modelClient.mini,
  apiKey: modelClient.apiKey,
}),
```

- [ ] **Step 5: Replace responseGenerator `openai()` call**

Change:
```ts
model: openai({
  model: process.env.OPENAI_MODEL_MINI || "gpt-4o",
  baseUrl: process.env.OPENAI_BASE_URL,
}),
```

To:
```ts
model: openai({
  ...modelClient.mini,
  apiKey: modelClient.apiKey,
}),
```

- [ ] **Step 6: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 7: Verify existing flow still works**

Start dev server and Inngest dev server:
```bash
npm run dev
```
Send a message without selecting a model. In Inngest dashboard (http://localhost:8288), verify the `code-agent/run` event triggers and the `get-model-client` step runs without errors.

- [ ] **Step 8: Commit**

```bash
git add src/inngest/functions.ts
git commit -m "feat: use dynamic model client in Inngest agent function"
```

---

## Task 11: Settings page with admin gate

**Files:**
- Create: `src/app/settings/page.tsx`
- Create: `src/modules/settings/ui/views/settings-view.tsx`

- [ ] **Step 1: Create `src/app/settings/page.tsx`**

```tsx
import { redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";

import { prisma } from "@/lib/db";
import { SettingsView } from "@/modules/settings/ui/views/settings-view";

export default async function SettingsPage() {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");

  const user = await prisma.user.findUnique({
    where: { clerkId: userId },
    select: { isAdmin: true },
  });

  if (!user?.isAdmin) redirect("/");

  return <SettingsView />;
}
```

- [ ] **Step 2: Create `src/modules/settings/ui/views/settings-view.tsx`**

```tsx
"use client";

import { useQuery } from "@tanstack/react-query";
import { useTRPC } from "@/trpc/client";
import { ProvidersSection } from "../components/providers-section";

export function SettingsView() {
  const trpc = useTRPC();
  const { data: providers, refetch } = useQuery(
    trpc.providers.list.queryOptions()
  );

  return (
    <div className="max-w-4xl mx-auto p-8">
      <h1 className="text-2xl font-bold mb-2">Settings</h1>
      <p className="text-muted-foreground mb-8">Admin configuration panel.</p>
      <ProvidersSection providers={providers ?? []} onRefetch={refetch} />
    </div>
  );
}
```

- [ ] **Step 3: Create the providers section placeholder** (full implementation in Task 12)

```tsx
// src/modules/settings/ui/components/providers-section.tsx
"use client";

export function ProvidersSection({
  providers,
  onRefetch,
}: {
  providers: unknown[];
  onRefetch: () => void;
}) {
  return (
    <div>
      <h2 className="text-xl font-semibold mb-4">AI Providers</h2>
      <p className="text-muted-foreground">Loading provider management UI...</p>
    </div>
  );
}
```

- [ ] **Step 4: Verify admin gate**

1. Sign in as a non-admin user. Navigate to `http://localhost:4000/settings` — should redirect to `/`.
2. In DB (Prisma Studio), set your user's `isAdmin = true`. Navigate to `http://localhost:4000/settings` — should show "AI Providers" heading.

- [ ] **Step 5: Commit**

```bash
git add src/app/settings/page.tsx src/modules/settings/ui/views/settings-view.tsx src/modules/settings/ui/components/providers-section.tsx
git commit -m "feat: add admin-gated settings page"
```

---

## Task 12: Providers admin UI

**Files:**
- Modify: `src/modules/settings/ui/components/providers-section.tsx`
- Create: `src/modules/settings/ui/components/provider-form-modal.tsx`
- Create: `src/modules/settings/ui/components/models-list.tsx`

- [ ] **Step 1: Create `src/modules/settings/ui/components/models-list.tsx`**

```tsx
"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Trash2Icon, PlusIcon } from "lucide-react";
import { useTRPC } from "@/trpc/client";
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";

interface Model {
  id: string;
  name: string;
  displayName: string;
  isActive: boolean;
  isAutoDiscovered: boolean;
}

interface Props {
  providerId: string;
  models: Model[];
  onRefetch: () => void;
}

export function ModelsList({ providerId, models, onRefetch }: Props) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [newName, setNewName] = useState("");
  const [newDisplay, setNewDisplay] = useState("");

  const toggle = useMutation(
    trpc.models.toggleActive.mutationOptions({
      onSuccess: () => { queryClient.invalidateQueries(); onRefetch(); },
    })
  );

  const deleteModel = useMutation(
    trpc.models.delete.mutationOptions({
      onSuccess: () => { queryClient.invalidateQueries(); onRefetch(); },
    })
  );

  const createModel = useMutation(
    trpc.models.create.mutationOptions({
      onSuccess: () => {
        setNewName("");
        setNewDisplay("");
        queryClient.invalidateQueries();
        onRefetch();
      },
      onError: (e) => toast.error(e.message),
    })
  );

  return (
    <div className="space-y-2">
      {models.map((model) => (
        <div key={model.id} className="flex items-center justify-between py-1 px-2 rounded hover:bg-muted/50">
          <div className="flex items-center gap-3">
            <Switch
              checked={model.isActive}
              onCheckedChange={() => toggle.mutate({ id: model.id })}
            />
            <span className="text-sm font-mono">{model.name}</span>
            {model.displayName !== model.name && (
              <span className="text-xs text-muted-foreground">{model.displayName}</span>
            )}
            {model.isAutoDiscovered && (
              <span className="text-[10px] text-muted-foreground border rounded px-1">auto</span>
            )}
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            onClick={() => deleteModel.mutate({ id: model.id })}
          >
            <Trash2Icon className="size-3" />
          </Button>
        </div>
      ))}

      <div className="flex gap-2 pt-2 items-center">
        <Input
          placeholder="model-name (API)"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          className="h-7 text-xs"
        />
        <Input
          placeholder="Display Name"
          value={newDisplay}
          onChange={(e) => setNewDisplay(e.target.value)}
          className="h-7 text-xs"
        />
        <Button
          size="icon"
          className="size-7 shrink-0"
          disabled={!newName || !newDisplay}
          onClick={() =>
            createModel.mutate({
              providerId,
              name: newName,
              displayName: newDisplay,
            })
          }
        >
          <PlusIcon className="size-3" />
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create `src/modules/settings/ui/components/provider-form-modal.tsx`**

```tsx
"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2Icon } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTRPC } from "@/trpc/client";
import { ModelsList } from "./models-list";

const schema = z.object({
  name: z.string().min(1, "Required"),
  baseUrl: z.string().url("Must be a valid URL"),
  apiKey: z.string().min(1, "Required"),
});

type FormValues = z.infer<typeof schema>;

interface Model {
  id: string;
  name: string;
  displayName: string;
  isActive: boolean;
  isAutoDiscovered: boolean;
}

interface Provider {
  id: string;
  name: string;
  baseUrl: string;
  isActive: boolean;
  models: Model[];
}

interface Props {
  open: boolean;
  onClose: () => void;
  provider?: Provider;
  onRefetch: () => void;
}

export function ProviderFormModal({ open, onClose, provider, onRefetch }: Props) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const isEdit = !!provider;
  // models derived from prop — updated by parent after each mutation via onRefetch
  const models = provider?.models ?? [];

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: provider?.name ?? "",
      baseUrl: provider?.baseUrl ?? "",
      apiKey: "",
    },
  });

  const create = useMutation(
    trpc.providers.create.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries();
        onRefetch();
        onClose();
        toast.success("Provider created");
      },
      onError: (e) => toast.error(e.message),
    })
  );

  const update = useMutation(
    trpc.providers.update.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries();
        onRefetch();
        toast.success("Provider updated");
      },
      onError: (e) => toast.error(e.message),
    })
  );

  const discover = useMutation(
    trpc.providers.discoverModels.mutationOptions({
      onSuccess: (result) => {
        toast.success(`Found ${result.length} models`);
        onRefetch(); // parent re-fetches → provider.models prop updates → models variable updates
      },
      onError: (e) => toast.error(e.message),
    })
  );

  const onSubmit = (values: FormValues) => {
    if (isEdit) {
      update.mutate({
        id: provider.id,
        name: values.name,
        baseUrl: values.baseUrl,
        ...(values.apiKey ? { apiKey: values.apiKey } : {}),
      });
    } else {
      create.mutate(values);
    }
  };

  const isPending = create.isPending || update.isPending;

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit Provider" : "Add Provider"}</DialogTitle>
        </DialogHeader>

        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-2">
            <Label>Name</Label>
            <Input placeholder="OpenRouter" {...form.register("name")} />
            {form.formState.errors.name && (
              <p className="text-xs text-destructive">{form.formState.errors.name.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label>Base URL</Label>
            <Input placeholder="https://openrouter.ai/api/v1" {...form.register("baseUrl")} />
            {form.formState.errors.baseUrl && (
              <p className="text-xs text-destructive">{form.formState.errors.baseUrl.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label>{isEdit ? "API Key (leave blank to keep current)" : "API Key"}</Label>
            <Input type="password" placeholder="sk-..." {...form.register("apiKey")} />
            {form.formState.errors.apiKey && (
              <p className="text-xs text-destructive">{form.formState.errors.apiKey.message}</p>
            )}
          </div>

          {isEdit && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label>Models</Label>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  disabled={discover.isPending}
                  onClick={() => discover.mutate({ id: provider.id })}
                >
                  {discover.isPending ? (
                    <Loader2Icon className="size-3 animate-spin mr-1" />
                  ) : null}
                  Discover Models
                </Button>
              </div>
              <ModelsList
                providerId={provider.id}
                models={models}
                onRefetch={onRefetch}
              />
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending ? <Loader2Icon className="size-4 animate-spin mr-1" /> : null}
              {isEdit ? "Save" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 3: Replace `src/modules/settings/ui/components/providers-section.tsx` with full implementation**

```tsx
"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { PlusIcon, PencilIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { useTRPC } from "@/trpc/client";
import { ProviderFormModal } from "./provider-form-modal";

interface Model {
  id: string;
  name: string;
  displayName: string;
  isActive: boolean;
  isAutoDiscovered: boolean;
}

interface Provider {
  id: string;
  name: string;
  baseUrl: string;
  isActive: boolean;
  models: Model[];
  _count: { models: number };
}

interface Props {
  providers: Provider[];
  onRefetch: () => void;
}

export function ProvidersSection({ providers, onRefetch }: Props) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Provider | undefined>();

  const deleteProvider = useMutation(
    trpc.providers.delete.mutationOptions({
      onSuccess: () => {
        queryClient.invalidateQueries();
        onRefetch();
        toast.success("Provider deleted");
      },
      onError: (e) => toast.error(e.message),
    })
  );

  const openAdd = () => {
    setEditing(undefined);
    setModalOpen(true);
  };

  const openEdit = (p: Provider) => {
    setEditing(p);
    setModalOpen(true);
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-semibold">AI Providers</h2>
        <Button size="sm" onClick={openAdd}>
          <PlusIcon className="mr-1" /> Add Provider
        </Button>
      </div>

      {providers.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No providers configured. Add one to enable model selection.
        </p>
      ) : (
        <div className="border rounded-lg divide-y">
          {providers.map((p) => (
            <div key={p.id} className="flex items-center justify-between px-4 py-3">
              <div>
                <p className="font-medium text-sm">{p.name}</p>
                <p className="text-xs text-muted-foreground font-mono truncate max-w-xs">
                  {p.baseUrl}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {p._count.models} model{p._count.models !== 1 ? "s" : ""}{" "}
                  ({p.models.length} active)
                </p>
              </div>
              <div className="flex gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  onClick={() => openEdit(p)}
                >
                  <PencilIcon className="size-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 text-destructive hover:text-destructive"
                  onClick={() => deleteProvider.mutate({ id: p.id })}
                >
                  <Trash2Icon className="size-3.5" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <ProviderFormModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        provider={editing}
        onRefetch={onRefetch}
      />
    </div>
  );
}
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: End-to-end test of admin UI**

1. Go to `http://localhost:4000/settings`
2. Click "Add Provider" — fill in Name: `Test`, Base URL: `https://api.openai.com/v1`, API Key: any value
3. Click "Create" — provider appears in list
4. Click Edit — click "Discover Models" — models list should populate from OpenAI
5. Toggle a model active/inactive — check Prisma Studio to confirm DB update
6. Add a manual model: type `custom-model` and `Custom Model`, click `+`
7. Delete the test provider — confirm it disappears

- [ ] **Step 6: Commit**

```bash
git add src/modules/settings/
git commit -m "feat: add admin UI for provider and model management"
```

---

## Task 13: Model dropdown in chat form

**Files:**
- Modify: `src/modules/projects/ui/components/message-form.tsx`

- [ ] **Step 1: Add model query and localStorage state to `message-form.tsx`**

Add these imports at the top:
```ts
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
```

Add the model query and state inside `MessageForm` (after the existing `useQuery` for usage):
```ts
const { data: models } = useQuery(trpc.models.listActive.queryOptions());

const [selectedModelId, setSelectedModelId] = useState<string>(() => {
  if (typeof window !== "undefined") {
    return localStorage.getItem("vibe:selectedModelId") ?? "";
  }
  return "";
});

const handleModelChange = (modelId: string) => {
  setSelectedModelId(modelId);
  localStorage.setItem("vibe:selectedModelId", modelId);
};
```

- [ ] **Step 2: Pass `modelId` in `onSubmit`**

Change `onSubmit`:
```ts
const onSubmit = async (values: z.infer<typeof formSchema>) => {
  await createMessage.mutateAsync({
    value: values.value,
    projectId,
    modelId: selectedModelId || undefined,
  });
};
```

- [ ] **Step 3: Add the dropdown to the form JSX**

Replace the `<div className="flex gap-x-2 items-end justify-between pt-2">` block:

```tsx
<div className="flex gap-x-2 items-end justify-between pt-2">
  <div className="flex items-center gap-2">
    {models && models.length > 0 && (
      <Select value={selectedModelId} onValueChange={handleModelChange}>
        <SelectTrigger className="h-7 text-xs w-auto max-w-[200px] border-none bg-transparent shadow-none focus:ring-0 px-2">
          <SelectValue placeholder="Default model" />
        </SelectTrigger>
        <SelectContent>
          {models.map((m) => (
            <SelectItem key={m.id} value={m.id} className="text-xs">
              {m.provider.name} / {m.displayName}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    )}
    <div className="text-[10px] text-muted-foreground font-mono">
      <kbd className="ml-auto pointer-events-none inline-flex h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground">
        <span>&#8984;</span>Enter
      </kbd>
      &nbsp;to submit
    </div>
  </div>
  <Button
    disabled={isButtonDisabled}
    className={cn(
      "size-8 rounded-full",
      isButtonDisabled && "bg-muted-foreground border"
    )}
  >
    {isPending ? (
      <Loader2Icon className="size-4 animate-spin" />
    ) : (
      <ArrowUpIcon />
    )}
  </Button>
</div>
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: End-to-end test**

1. Go to a project page
2. If no models in DB: dropdown should NOT appear — form looks identical to before
3. Add a provider + activate a model via settings
4. Reload project page — dropdown appears showing `ProviderName / ModelName`
5. Select a model, send a message
6. In Prisma Studio, find the new Message record — `modelId` should be set
7. In Inngest dashboard, verify the `get-model-client` step ran with the correct model

- [ ] **Step 6: Commit**

```bash
git add src/modules/projects/ui/components/message-form.tsx
git commit -m "feat: add model selector dropdown to chat form"
```

---

## Task 14: Final verification checklist

- [ ] **Add Ollama provider** — Name: `Ollama`, Base URL: `http://localhost:11434/v1`, API Key: `ollama`
  - Click "Discover Models" — should list your locally available models
  - Activate one, send a message selecting it
  - In Inngest logs, confirm the agent called `http://localhost:11434/v1`

- [ ] **Fallback test** — Ensure no model is selected (clear localStorage key `vibe:selectedModelId`), send a message — should use env vars (`gpt-5.4`)

- [ ] **DB encryption check** — In Prisma Studio, inspect `Provider.apiKeyEnc` — confirm it is NOT the plaintext API key (should look like `<hex>:<hex>:<hex>`)

- [ ] **Non-admin redirect** — Sign in with a non-admin account. Navigate to `http://localhost:4000/settings` — should redirect to `/`

- [ ] **OpenRouter test** — Add OpenRouter provider (`https://openrouter.ai/api/v1`), discover models, select one, send message — verify it works in Inngest logs

- [ ] **localStorage persistence** — Select a model, refresh page — same model should still be selected in the dropdown
