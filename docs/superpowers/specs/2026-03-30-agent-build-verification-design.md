# Agent Build Verification — Design Spec

**Date:** 2026-03-30
**Status:** Approved

## Problem

The `codeAgent` writes files into the E2B sandbox and terminates as soon as it emits `<task_summary>`. There is no step that verifies the code compiles or that TypeScript errors are absent. The result is that broken code gets saved to the database and shown to the user as a successful fragment.

**Example failure:**
```
CssSyntaxError: tailwindcss: /home/user/app/globals.css:1:1: Can't resolve 'tw-animate-css'
```
The agent wrote a CSS file that references an uninstalled package, emitted its summary, and finished — with no error detected.

---

## Goals

1. The agent auto-corrects errors **during** execution (before emitting `<task_summary>`)
2. A programmatic verification step **guarantees** TypeScript compilation passes before the result is saved
3. The system does not loop infinitely on unfixable errors

---

## Architecture

### Current Flow
```
network.run()
  → codeAgent (loop until summary)
  → stop
  → save to DB
```

### New Flow
```
network.run()
  → codeAgent (loop)
  → (summary present?) → verifierAgent
      → VERIFICATION_OK  → stop
      → VERIFICATION_FAILED → clear summary, errors in message history
          → codeAgent sees errors, fixes them → emits summary again
          → verifierAgent runs again
          → (max 3 attempts, then bail out)
  → save to DB
```

Agents share the same message history in the `agent-kit` network. When `verifierAgent` outputs errors, `codeAgent` sees them in context on its next iteration and knows what to fix — no manual injection needed.

---

## State

```ts
interface AgentState {
  summary: string;
  files: { [path: string]: string };
  verified: boolean;            // true when tsc passes cleanly
  verificationAttempts: number; // capped at 3
}
```

**Default state:**
```ts
{
  summary: "",
  files: {},
  verified: false,
  verificationAttempts: 0,
}
```

---

## verifierAgent

**Responsibility:** Run `npx tsc --noEmit` and report results. Nothing else.

**Tools available:** `terminal` only (read-only check, no file writes).

**System prompt:**
```
You are a verification agent. Your ONLY job is to check for TypeScript errors.

1. Run: npx tsc --noEmit 2>&1
2. If NO errors → respond with exactly: VERIFICATION_OK
3. If errors exist → respond with exactly: VERIFICATION_FAILED
   followed by the full error output.

Do not explain. Do not fix. Just report.
```

**Lifecycle — `onResponse`:**
```ts
onResponse: async ({ result, network }) => {
  const content = lastAssistantTextMessageContent(result);
  network.state.data.verificationAttempts += 1;

  if (content?.includes("VERIFICATION_OK")) {
    network.state.data.verified = true;
  } else {
    // Clear summary so router loops back to codeAgent.
    // Errors remain in message history for codeAgent to read.
    network.state.data.summary = "";
  }
  return result;
}
```

---

## Router

```ts
router: async ({ network }) => {
  const { summary, verified, verificationAttempts } = network.state.data;

  // Has summary but not yet verified
  if (summary && !verified) {
    if (verificationAttempts >= 3) return; // bail out after 3 failed attempts
    return verifierAgent;
  }

  // Verified successfully
  if (summary && verified) return;

  // Still working
  return codeAgent;
};
```

**`maxIter`** stays at 15. Each verification cycle uses 1 iteration from the verifierAgent and potentially several from codeAgent fixing errors. The 3-attempt cap prevents runaway loops independently of `maxIter`.

---

## PROMPT Changes (codeAgent)

### 1. Allow `npx tsc --noEmit`

In the "Runtime Execution (Strict Rules)" section, add an exception:

```
- Exception: you MAY run `npx tsc --noEmit` to verify TypeScript
  compilation before finalizing. This is a read-only check and
  does not start a server.
```

### 2. Mandatory pre-completion check

Add before the "Final output (MANDATORY)" section:

```
Pre-completion check (MANDATORY):
Before outputting <task_summary>, you MUST run `npx tsc --noEmit`
via the terminal tool. If there are TypeScript errors, fix them
first. Only output <task_summary> when the check passes cleanly.

If you see VERIFICATION_FAILED errors in the conversation from
a previous verification step, treat them as your next task —
fix all listed errors before re-emitting <task_summary>.
```

---

## Files to Change

| File | Change |
|------|--------|
| `src/inngest/functions.ts` | Add `verified` + `verificationAttempts` to `AgentState`; create `verifierAgent`; add both agents to network; update router |
| `src/prompt.ts` | Add tsc exception to runtime rules; add pre-completion check section |

No new files required.

---

## Error Handling

| Scenario | Behaviour |
|----------|-----------|
| `tsc` passes first try | `verified = true`, network stops, result saved normally |
| `tsc` fails, codeAgent fixes it | Cleared summary → codeAgent reruns → verifier passes on retry |
| `tsc` fails 3 times | `verificationAttempts >= 3` → bail out, network stops, `isError` flag triggers error message to user |
| `verifierAgent` tool call fails | `VERIFICATION_OK` not found → treated as failure → codeAgent retries |

---

## Out of Scope

- Runtime errors visible only in the browser (e.g. Clipboard API blocked) — these are sandbox permission issues unrelated to TypeScript compilation
- CSS/PostCSS errors from packages not installed — addressed indirectly: the agent's CSS rule violation (`MUST NOT modify .css files`) is a prompt constraint already in place; this spec does not change that rule
