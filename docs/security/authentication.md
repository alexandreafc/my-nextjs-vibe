# Authentication Architecture

## Purpose

This document explains how authentication works in this project, which parts of the stack participate in auth, and how to troubleshoot common failures.

The application uses Clerk for authentication and authorization across:

- client-side session state
- Next.js middleware protection
- server-side request authentication
- protected tRPC procedures
- usage and credit enforcement

## Main Components

### `src/app/layout.tsx`

Wraps the application with `ClerkProvider`, making Clerk session state available to client components.

### `src/middleware.ts`

Runs `clerkMiddleware()` for app and API requests.

Current behavior:

- public pages such as `/`, `/sign-in`, `/sign-up`, and `/pricing` are allowed
- non-public, non-API pages call `auth.protect()`
- API routes still pass through Clerk middleware, which allows server-side auth helpers to resolve request auth state

### `src/trpc/client.tsx`

The tRPC client uses Clerk's `useAuth().getToken()` and injects the token into the `Authorization` header for requests made to `/api/trpc`.

This is important because protected procedures depend on authenticated server context, and the token is the credential that reaches the route handler.

### `src/app/api/trpc/[trpc]/route.ts`

This is the tRPC HTTP entrypoint. It delegates to `fetchRequestHandler()` and builds request context through `createTRPCContext`.

### `src/trpc/init.ts`

This file creates the tRPC context and defines `protectedProcedure`.

Authentication is enforced here:

- `createTRPCContext()` calls Clerk `auth()`
- `protectedProcedure` rejects requests with no `ctx.auth.userId`

If `auth()` cannot resolve the current user, every protected tRPC route will fail with `UNAUTHORIZED` / `Not authenticated`.

### `src/lib/usage.ts`

Usage and credit enforcement also call Clerk `auth()`.

That means a request may pass the tRPC auth boundary but still fail later if server-side auth is misconfigured and `auth()` cannot resolve the current user while checking credits or usage.

## End-to-End Auth Flow

### 1. User signs in through Clerk

Clerk establishes the browser session and exposes client auth state through hooks like:

- `useAuth()`
- `useClerk()`
- `useUser()`

### 2. Client prepares authenticated API requests

When the app calls tRPC:

- `useAuth().getToken()` retrieves the current Clerk session token
- `httpBatchLink` sends `Authorization: Bearer <token>` to `/api/trpc`

### 3. Middleware runs before route handlers

`clerkMiddleware()` processes the request first. This is where Clerk prepares request auth state for downstream server helpers.

### 4. Route handler creates tRPC context

`createTRPCContext()` calls `auth()` from `@clerk/nextjs/server`.

If successful, `ctx.auth.userId` and `ctx.auth.sessionId` are available.

### 5. Protected procedures enforce access

`protectedProcedure` checks:

```ts
if (!ctx.auth.userId) {
  throw new TRPCError({
    code: "UNAUTHORIZED",
    message: "Not authenticated",
  });
}
```

### 6. Domain logic may re-check auth

Functions like `consumeCredits()` and `getUsageStatus()` call `auth()` again on the server, so Clerk must be correctly configured across the entire request lifecycle.

## Protected Areas

The following areas are auth-sensitive:

- `projects.getOne`
- `projects.getMany`
- `projects.create`
- `messages.getMany`
- `messages.create`
- `usage.status`
- credit consumption in `src/lib/usage.ts`

## Required Environment Variables

Auth depends on Clerk variables in `.env`:

```bash
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=""
CLERK_SECRET_KEY=""
NEXT_PUBLIC_CLERK_SIGN_IN_URL="/sign-in"
NEXT_PUBLIC_CLERK_SIGN_UP_URL="/sign-up"
NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL="/"
NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL="/"
```

## Critical Invariant

`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY` must belong to the same Clerk application / instance.

If they do not match, the browser may appear signed in while the server rejects the token.

## Failure Mode Seen In This Project

### Symptom

The homepage button to generate an app failed with:

- `TRPCClientError: Not authenticated`
- `401` on `projects.getMany`
- `401` on `projects.create`

### Confirmed Root Cause

The server-side Clerk configuration was invalid for the token being sent.

Clerk debug output reported:

- `authReason: secret-key-invalid`

This meant:

- the request did reach `/api/trpc`
- the client did send a valid-looking bearer token
- the request also carried Clerk session cookies
- but Clerk could not validate the token on the server because the configured secret key was invalid or mismatched

### Why This Was Misleading

On the client, Clerk hooks still showed:

- `userId`
- `sessionId`
- a valid token from `getToken()`

So the UI looked authenticated while the server rejected the same session at verification time.

## Troubleshooting Guide

### If you see `TRPCClientError: Not authenticated`

Check these in order:

1. Is the user actually signed in in the browser?
2. Is the request sending `Authorization: Bearer <token>` from `src/trpc/client.tsx`?
3. Does `src/middleware.ts` still use `clerkMiddleware()`?
4. Does `createTRPCContext()` still call Clerk `auth()`?
5. Are `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY` from the same Clerk app?

### If Clerk says `secret-key-invalid`

Fix:

1. Replace `CLERK_SECRET_KEY` with the correct secret key for the same Clerk instance as the publishable key.
2. Restart the Next.js dev server.
3. Sign out and sign in again if the browser session is stale.

### If client is signed in but server is signed out

Likely causes:

- invalid Clerk secret key
- publishable key / secret key mismatch
- stale environment after `.env` changes
- middleware not running on the request path

### If protected pages work but API auth fails

Check:

- `src/trpc/client.tsx` still adds the authorization header
- the request still targets `/api/trpc`
- the route handler still uses `createTRPCContext`

## Security Notes

- Never commit `.env` or secret keys.
- Treat `CLERK_SECRET_KEY` as server-only.
- Do not log raw session tokens in normal application code.
- If you temporarily add auth debugging, remove it after verification.
- Any change to auth env vars requires a server restart.

## Maintenance Notes

If auth is refactored in the future, re-check these files first:

- `src/app/layout.tsx`
- `src/middleware.ts`
- `src/trpc/client.tsx`
- `src/app/api/trpc/[trpc]/route.ts`
- `src/trpc/init.ts`
- `src/lib/usage.ts`

## Summary

Authentication in this project depends on a continuous chain:

`ClerkProvider` -> `useAuth().getToken()` -> `Authorization` header -> `clerkMiddleware()` -> server `auth()` -> `protectedProcedure`

If any link in that chain fails, protected tRPC procedures and usage checks will reject the request.

The most important operational lesson from this incident is that a browser appearing signed in does not prove the server can validate the same session. Always verify Clerk server auth separately when debugging protected API calls.
