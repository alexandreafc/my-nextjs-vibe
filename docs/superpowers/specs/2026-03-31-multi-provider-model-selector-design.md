# Multi-Provider Model Selector — Design Spec

**Date:** 2026-03-31
**Status:** Approved

## Context

The app currently hardcodes OpenAI as the only LLM provider via env vars (`OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL`). The goal is to support any OpenAI-compatible provider (LiteLLM, OpenRouter, Ollama, etc.), allow admins to configure multiple providers via a settings UI, and let users choose which model to use per message in the chat.

The `@inngest/agent-kit` OpenAI client already accepts `baseUrl` and `apiKey` dynamically — so the architecture supports this with minimal structural changes.

---

## Data Model (Prisma)

### New Tables

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
  apiKeyEnc String           // AES-256-GCM encrypted
  isActive  Boolean  @default(true)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  models    Model[]
}

model Model {
  id               String    @id @default(cuid())
  providerId       String
  provider         Provider  @relation(fields: [providerId], references: [id], onDelete: Cascade)
  name             String    // e.g. "llama3.2", "gpt-4o"
  displayName      String    // e.g. "Llama 3.2", "GPT-4o"
  isActive         Boolean   @default(true)
  isAutoDiscovered Boolean   @default(false)
  createdAt        DateTime  @default(now())
  messages         Message[]
}
```

### Changed Table

```prisma
model Message {
  // existing fields unchanged...
  modelId  String?
  model    Model?  @relation(fields: [modelId], references: [id])
}
```

### API Key Encryption

AES-256-GCM via Node.js `crypto`. New env var `ENCRYPTION_KEY` (32-byte hex string).
Utility at `src/lib/crypto.ts` with `encrypt(text): string` and `decrypt(encrypted): string`.

---

## Inngest Layer

### Event Data

```ts
// Add optional modelId to existing event
event.data = { projectId: string, value: string, modelId?: string }
```

### New Utility: `src/lib/create-model-client.ts`

```ts
export async function createModelClient(modelId?: string) {
  if (!modelId) {
    // Retrocompatible fallback to env vars
    return {
      primary: { model: process.env.OPENAI_MODEL ?? "gpt-5.4", baseUrl: process.env.OPENAI_BASE_URL },
      mini:    { model: process.env.OPENAI_MODEL_MINI ?? "gpt-5.4-mini", baseUrl: process.env.OPENAI_BASE_URL },
      apiKey:  process.env.OPENAI_API_KEY,
    }
  }

  const record = await prisma.model.findUniqueOrThrow({
    where: { id: modelId },
    include: { provider: true }
  })

  const apiKey = decrypt(record.provider.apiKeyEnc)

  return {
    primary: { model: record.name, baseUrl: record.provider.baseUrl },
    mini:    { model: process.env.OPENAI_MODEL_MINI ?? record.name, baseUrl: record.provider.baseUrl },
    apiKey,
  }
}
```

### Updated `src/inngest/functions.ts`

Replace hardcoded `openai()` calls with dynamic client. All 4 agents updated:

```ts
const { primary, mini, apiKey } = await createModelClient(event.data.modelId)

// codeAgent — temperature 0.1 preserved
model: openai({ ...primary, apiKey, defaultParameters: { temperature: 0.1 } })

// verifierAgent — temperature 0 preserved
model: openai({ ...primary, apiKey, defaultParameters: { temperature: 0 } })

// fragmentTitleGenerator + responseGenerator
model: openai({ ...mini, apiKey })
```

The verification loop (3-branch router, `verified`/`verificationAttempts` state, `isError` check) is **unchanged**.

Note: `baseUrl` (not `baseURL`) — matches current agent-kit parameter name.

---

## tRPC Routers

### `src/trpc/routers/providers.ts` (admin only)

| Procedure | Description |
|-----------|-------------|
| `list()` | List all providers with model counts |
| `create({ name, baseUrl, apiKey })` | Create new provider |
| `update({ id, ...fields })` | Update provider |
| `delete({ id })` | Delete provider (cascades to models) |
| `discoverModels({ id })` | `GET {baseUrl}/v1/models` → merge with existing |

### `src/trpc/routers/models.ts`

| Procedure | Access | Description |
|-----------|--------|-------------|
| `listActive()` | All users | Returns `{ id, displayName, providerName }` for chat dropdown |
| `create({ providerId, name, displayName })` | Admin only | Add manual model |
| `toggleActive({ id })` | Admin only | Enable/disable model |
| `delete({ id })` | Admin only | Remove model |

### `src/trpc/routers/messages.ts`

Add `modelId?: string` to `create` input.

### `src/trpc/routers/users.ts`

| Procedure | Description |
|-----------|-------------|
| `syncCurrent()` | Upsert User from Clerk session (called in layout) |

### `src/trpc/middleware/admin.ts`

Verifies `User.isAdmin` via clerkId from session. Throws `TRPCError` with code `FORBIDDEN` if not admin.

---

## Admin UI (`/settings`)

**Route:** `src/app/(dashboard)/settings/page.tsx`

- "AI Providers" tab visible only when `isAdmin === true`
- Non-admin direct access → redirect to `/`

### Provider List View

Table columns: Name, Base URL (truncated), Model Count, Active status, Edit / Delete actions.
"+ Add Provider" button opens modal.

### Provider Modal (Add / Edit)

Fields:
- **Name** — display name (e.g. "OpenRouter")
- **Base URL** — API endpoint (e.g. `https://openrouter.ai/api/v1`)
- **API Key** — password input (masked, never shown after save)

Actions:
- **Discover Models** button → calls `providers.discoverModels`, shows merged list
- Per-model toggle (active/inactive)
- Manual model form: `name` (API name) + `displayName` (shown to users)

### Promoting Admins

No UI — direct DB update or seed script only:

```ts
await prisma.user.update({
  where: { clerkId: "user_xxxx" },
  data: { isAdmin: true }
})
```

---

## Chat UI

**File:** `src/modules/projects/ui/components/message-form.tsx`

- Fetch `api.models.listActive()` on mount (React Query cache)
- Dropdown positioned left of send button
- Item format: `ProviderName / ModelDisplayName`
- Persists last selection in `localStorage` key `vibe:selectedModelId`
- Hidden entirely if no active models in DB (silent fallback to env vars)
- Selected `modelId` passed to `messages.create()`

---

## User Sync

**File:** `src/app/(dashboard)/layout.tsx`

Call `users.syncCurrent()` on mount to upsert `User` record from Clerk session (creates with `isAdmin: false` if first login).

---

## Verification Checklist

1. Add Ollama provider via settings UI → discover models → activate one
2. Send message selecting that model → verify in Inngest logs it used the right provider
3. Verify `Message.modelId` is set in DB after send
4. Send message without selecting model → verify fallback to env vars (`gpt-5.4`)
5. Access `/settings` as non-admin → verify redirect to `/`
6. Inspect DB `apiKeyEnc` column → verify it is NOT plaintext
