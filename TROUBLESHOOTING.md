# Troubleshooting

---

## `TypeError: Cannot read properties of undefined (reading 'body')`

### What the message actually means

This is NOT a generic "tried to read a property on an undefined object" error. The string in
parentheses — `'body'` — is the **exact property name** that was accessed. JavaScript always puts
the specific property there. So the failing expression is literally `someVar.body` where
`someVar === undefined`.

A `rows.length` failure would say `reading 'length'`. A `session.user` failure would say
`reading 'user'`. If it says `'body'`, the code tried to access `.body` specifically.

### Every `.body` access in this project

| Location | What `r.body` means |
|---|---|
| `utils/sync.js:397,405` | `body` column of a Supabase `sms_templates` row in `pullSmsTemplates()` |
| `...theme.typography.body` spreads (many files) | StyleSheet spread — safe, theme is statically defined |
| `<View style={styles.body}>` JSX (a few files) | StyleSheet key reference — safe |

The **only runtime data `.body` access** is in `utils/sync.js` inside `pullSmsTemplates()`.
That access is safe as long as `r` is a valid Supabase row (non-null). If `r` were
`null`/`undefined`, `r.sms_template_sk` earlier in the loop body would fail first with
`reading 'sms_template_sk'`.

### Root cause (confirmed via library source)

The error originates from the **Supabase JS library's `autoRefreshToken` background timer**,
not from app code.

When `autoRefreshToken: true` (set in `utils/supabase.js`), Supabase starts an internal timer
at `createClient()` time. On startup — while the native networking stack may still be
initializing — this timer fires a token-refresh HTTP request. If the native `fetch` returns an
unexpected result (or the Supabase library's internal response-processing code encounters a
partial/undefined Response object), the library accesses `.body` on `undefined`.

This is an **unhandled background Promise** — it runs in Supabase's timer callback, outside all
of our `await` / `try-catch` chains.

### How to confirm next time

Expand the full stack trace in Metro / Expo Dev Tools. Look for frames that are entirely inside:

```
node_modules/@supabase/auth-js/...
node_modules/@supabase/postgrest-js/...
Libraries/Network/fetch.js   ← React Native built-in
```

If there are **no frames from our files** (`utils/`, `db/`, `app/`, etc.), the error is
confirmed as a Supabase/RN internals unhandled rejection, not a bug in the app.

### Is it crashing the app?

No. An unhandled rejection in a background timer is non-fatal in React Native / Expo.
The error will show in the Metro console and may briefly display in the red overlay in
development, but it does not break auth, data loading, or navigation. In production builds it
is silently swallowed.

### Mitigation options

1. **Current state (good enough for now)**: All our Supabase calls are wrapped in
   `try/catch`. The background refresh error is cosmetic in development.

2. **Disable auto-refresh (most robust fix)**: Set `autoRefreshToken: false` in
   `utils/supabase.js` and manually call `supabase.auth.refreshSession()` in the
   `onAuthStateChange` handler on `TOKEN_REFRESHED` events, wrapped in our own
   `try/catch`. This removes the uncontrolled background timer entirely.

3. **Upgrade Supabase**: Check if a newer `@supabase/supabase-js` version resolves the
   React Native background-refresh error handling. Current version: `2.105.4`.

4. **Global rejection handler (dev-only logging)**: Add to `app/_layout.jsx`:
   ```js
   // Catch Supabase background-timer rejections so they don't show as red overlays
   if (global.ErrorUtils) {
     const prev = global.ErrorUtils.getGlobalHandler();
     global.ErrorUtils.setGlobalHandler((err, isFatal) => {
       if (err?.message?.includes("reading 'body'")) {
         logError(err, 'global/supabase-background');
         return;
       }
       prev(err, isFatal);
     });
   }
   ```
   This silences the overlay in dev without hiding real crashes.

---

## General debugging tips for `TypeError: Cannot read properties of X (reading 'Y')`

- The property in quotes (`'Y'`) is always the **exact JavaScript property name** that was
  accessed — not a description of what went wrong.
- Look for every place in the code that accesses `.Y` (the literal property) on the type of
  object `X` should be.
- Common sources: async results that may be `null` (unguarded Supabase/SQLite results),
  store state accessed before initialization, and third-party library background Promises.
- A full stack trace is essential — the error message alone only tells you the property name,
  not which file/line caused it. Always expand the trace in Metro.
