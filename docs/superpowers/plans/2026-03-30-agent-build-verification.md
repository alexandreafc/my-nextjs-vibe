# Agent Build Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `verifierAgent` that runs `npx tsc --noEmit` after the `codeAgent` finishes, auto-fixes TypeScript errors by looping back to `codeAgent`, and blocks saving to the database until verification passes.

**Architecture:** The existing `codeAgent` network gains a second agent — `verifierAgent` — with a single responsibility: run `npx tsc --noEmit` and report `VERIFICATION_OK` or `VERIFICATION_FAILED` with the full error output. The network router orchestrates the loop: `codeAgent → verifierAgent → (errors?) → codeAgent → ... → stop`. The `codeAgent` prompt is updated to instruct self-verification before emitting `<task_summary>`. A 3-attempt cap and an updated `isError` check prevent infinite loops and bad saves.

**Tech Stack:** TypeScript, `@inngest/agent-kit` v0.8.3, Inngest v3.39.2, OpenAI, E2B sandbox

---

## File Map

| File | Change |
|------|--------|
| `src/inngest/functions.ts` | Extract `terminalTool` to variable; add `verified` + `verificationAttempts` to `AgentState`; create `verifierAgent`; add it to `network.agents`; update router; update `isError` |
| `src/prompt.ts` | Add tsc exception to "Runtime Execution" rules; add "Pre-completion check" section before "Final output" |

---

## Task 1: Extend AgentState and default state

**Files:**
- Modify: `src/inngest/functions.ts`

- [ ] **Step 1: Add `verified` and `verificationAttempts` to the `AgentState` interface**

Open `src/inngest/functions.ts`. The current interface is at lines 12-15:

```ts
interface AgentState {
  summary: string;
  files: { [path: string]: string };
  verified: boolean;
  verificationAttempts: number;
}
```

- [ ] **Step 2: Update `createState` default values to include the new fields**

The `createState` call is at lines 51-59. Replace its first argument:

```ts
const state = createState<AgentState>(
  {
    summary: "",
    files: {},
    verified: false,
    verificationAttempts: 0,
  },
  {
    messages: previousMessages,
  },
);
```

- [ ] **Step 3: Verify TypeScript compiles with no errors**

```bash
cd /Users/alexandre/development/sandbox/ai/code-with-antionio/nextjs-vibe
npx tsc --noEmit
```

Expected: no output (zero errors).

- [ ] **Step 4: Commit**

```bash
git add src/inngest/functions.ts
git commit -m "feat: extend AgentState with verified and verificationAttempts fields"
```

---

## Task 2: Update PROMPT with tsc exception and pre-completion check

**Files:**
- Modify: `src/prompt.ts`

- [ ] **Step 1: Add tsc exception to "Runtime Execution (Strict Rules)"**

Open `src/prompt.ts`. Find the block that says:
```
- These commands will cause unexpected behavior or unnecessary terminal output.
- Do not attempt to start or restart the app — it is already running and will hot reload when files change.
- Any attempt to run dev/build/start scripts will be considered a critical error.
```

Add one line immediately after that block (before the blank line that follows it):
```
- Exception: you MAY run \`npx tsc --noEmit\` to verify TypeScript compilation. This is a read-only check and does not start a server.
```

- [ ] **Step 2: Add the mandatory pre-completion check section**

Find the line:
```
Final output (MANDATORY):
```

Insert the following block **immediately before** that line:

```
Pre-completion check (MANDATORY):
Before outputting <task_summary>, you MUST run \`npx tsc --noEmit\` via the terminal tool.
- If there are TypeScript errors, fix them and run the check again.
- Only output <task_summary> when the check produces zero errors.
- If you see VERIFICATION_FAILED errors in the conversation from a previous verification step, treat them as your next task — fix all listed errors before re-emitting <task_summary>.

```

- [ ] **Step 3: Verify TypeScript compiles with no errors**

```bash
npx tsc --noEmit
```

Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add src/prompt.ts
git commit -m "feat: require tsc pre-completion check in codeAgent prompt"
```

---

## Task 3: Extract terminal tool to a shared variable

**Files:**
- Modify: `src/inngest/functions.ts`

This step extracts the `terminal` tool definition so both `codeAgent` and the upcoming `verifierAgent` can share it without duplication.

- [ ] **Step 1: Extract the terminal tool into a named constant**

In `src/inngest/functions.ts`, the `terminal` tool is currently inlined inside `codeAgent`'s `tools` array (lines 73-101). Extract it to a `const` defined just before `codeAgent`:

```ts
const terminalTool = createTool({
  name: "terminal",
  description: "Use the terminal to run commands",
  parameters: z.object({
    command: z.string(),
  }),
  handler: async ({ command }, { step }) => {
    return await step?.run("terminal", async () => {
      const buffers = { stdout: "", stderr: "" };

      try {
        const sandbox = await getSandbox(sandboxId);
        const result = await sandbox.commands.run(command, {
          onStdout: (data: string) => {
            buffers.stdout += data;
          },
          onStderr: (data: string) => {
            buffers.stderr += data;
          },
        });
        return result.stdout;
      } catch (e) {
        console.error(
          `Command failed: ${e} \nstdout: ${buffers.stdout}\nstderror: ${buffers.stderr}`,
        );
        return `Command failed: ${e} \nstdout: ${buffers.stdout}\nstderr: ${buffers.stderr}`;
      }
    });
  },
});
```

- [ ] **Step 2: Replace the inlined terminal tool in `codeAgent` with `terminalTool`**

Update `codeAgent`'s `tools` array so the first element references the extracted constant. The `createOrUpdateFiles` and `readFiles` tool definitions remain exactly as they are now — only the `terminal` entry changes:

```ts
tools: [
  terminalTool,          // ← was the inlined terminal createTool(...) block
  createTool({           // createOrUpdateFiles — unchanged
    name: "createOrUpdateFiles",
    // ... existing definition stays as-is
  }),
  createTool({           // readFiles — unchanged
    name: "readFiles",
    // ... existing definition stays as-is
  }),
],
```

- [ ] **Step 3: Verify TypeScript compiles with no errors**

```bash
npx tsc --noEmit
```

Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add src/inngest/functions.ts
git commit -m "refactor: extract terminalTool to shared variable"
```

---

## Task 4: Create verifierAgent

**Files:**
- Modify: `src/inngest/functions.ts`

- [ ] **Step 1: Add `verifierAgent` after `codeAgent`'s closing brace**

Place this immediately after the `codeAgent` definition, before the `createNetwork` call:

```ts
const verifierAgent = createAgent<AgentState>({
  name: "verifier-agent",
  description: "Verifies TypeScript compilation after code changes",
  system: `You are a verification agent. Your ONLY job is to check for TypeScript errors.

1. Run: npx tsc --noEmit 2>&1
2. If there are NO errors → respond with exactly: VERIFICATION_OK
3. If there ARE errors → respond with exactly: VERIFICATION_FAILED
   followed by the full error output.

Do not explain. Do not fix code. Just report the result.`,
  model: openai({
    model: process.env.OPENAI_MODEL || "gpt-4.1",
    baseUrl: process.env.OPENAI_BASE_URL,
    defaultParameters: {
      temperature: 0,
    },
  }),
  tools: [terminalTool],
  lifecycle: {
    onResponse: async ({ result, network }) => {
      const content = lastAssistantTextMessageContent(result);

      if (network) {
        network.state.data.verificationAttempts += 1;

        if (content?.includes("VERIFICATION_OK")) {
          network.state.data.verified = true;
        } else {
          // Clear summary so the router routes back to codeAgent.
          // The error output stays in message history for codeAgent to read.
          network.state.data.summary = "";
        }
      }

      return result;
    },
  },
});
```

- [ ] **Step 2: Verify TypeScript compiles with no errors**

```bash
npx tsc --noEmit
```

Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add src/inngest/functions.ts
git commit -m "feat: add verifierAgent that runs npx tsc --noEmit and reports results"
```

---

## Task 5: Update network — add verifierAgent and new router

**Files:**
- Modify: `src/inngest/functions.ts`

- [ ] **Step 1: Add `verifierAgent` to the network's `agents` array**

Find the `createNetwork` call. Update the `agents` array:

```ts
const network = createNetwork<AgentState>({
  name: "coding-agent-network",
  agents: [codeAgent, verifierAgent],
  maxIter: 15,
  defaultState: state,
  router: async ({ network }) => { ... },
});
```

- [ ] **Step 2: Replace the router function with the new three-branch logic**

```ts
router: async ({ network }) => {
  const { summary, verified, verificationAttempts } = network.state.data;

  // Summary exists but not yet verified — send to verifierAgent
  if (summary && !verified) {
    // Bail out after 3 failed verification attempts
    if (verificationAttempts >= 3) return;
    return verifierAgent;
  }

  // Summary exists and verified — done
  if (summary && verified) return;

  // Still working — keep routing to codeAgent
  return codeAgent;
},
```

- [ ] **Step 3: Update the `isError` flag to also check `verified`**

Find the `isError` assignment after `network.run()`:

```ts
const isError =
  !result.state.data.summary ||
  Object.keys(result.state.data.files || {}).length === 0 ||
  !result.state.data.verified;
```

This ensures that if verification fails 3 times and we bail out, the result is saved as an error rather than a broken fragment.

- [ ] **Step 4: Verify TypeScript compiles with no errors**

```bash
npx tsc --noEmit
```

Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add src/inngest/functions.ts
git commit -m "feat: wire verifierAgent into network router with 3-attempt cap"
```

---

## Task 6: Manual smoke test

No automated test framework exists in this project. Verify the new flow manually using the Inngest dev server.

- [ ] **Step 1: Start the dev environment**

```bash
npm run dev
```

In a second terminal:

```bash
npx inngest-cli@latest dev -u http://localhost:4000/api/inngest
```

- [ ] **Step 2: Trigger a successful scenario**

Send a simple prompt through the UI (e.g., "Create a counter button"). Expected Inngest trace:
```
get-sandbox-id → get-previous-messages → terminal (tsc in codeAgent)
→ createOrUpdateFiles → terminal (verifier tsc)
→ [step ends: VERIFICATION_OK]
→ save-result (type=RESULT, not ERROR)
```

Confirm `verified = true` appears in the network state in the Inngest dashboard.

- [ ] **Step 3: Trigger an error scenario**

Send a prompt likely to produce a type error (e.g., "Create a component that uses a non-existent Shadcn prop"). Watch the Inngest trace for:
```
→ terminal (verifier: VERIFICATION_FAILED + errors)
→ summary cleared
→ codeAgent runs again with error context
→ terminal (verifier: VERIFICATION_OK)
→ save-result (type=RESULT)
```

- [ ] **Step 4: Verify the 3-attempt bail-out**

If needed, temporarily lower the cap to 1 in the router (`verificationAttempts >= 1`) and trigger an error prompt. Confirm `save-result` is called with `type=ERROR`. Restore to `>= 3` after confirming.

- [ ] **Step 5: Final commit if any adjustments were made during testing**

```bash
git add src/inngest/functions.ts src/prompt.ts
git commit -m "fix: adjust verification flow based on smoke test results"
```
