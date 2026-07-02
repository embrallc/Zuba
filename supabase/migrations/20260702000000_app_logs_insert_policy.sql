-- app_logs: re-assert the device INSERT policy + tighten grants to append-only.
--
-- Symptom this addresses: the device log shipper hitting
--   "new row violates row-level security policy for table app_logs".
-- The blanket GRANT ALL in 20260624000000 gives `authenticated` (and `anon`) base
-- privileges on EVERY public table, so app_logs inserts are gated purely by RLS.
-- If the app_logs_insert_own policy is ever missing/ineffective on an environment,
-- or a request arrives unauthenticated, the insert is rejected with that RLS error.
-- Re-assert the policy idempotently so every env (staging/prod) converges.
--
-- Also tighten the grant: app_logs is a PRIVATE, APPEND-ONLY sink (owner reads via
-- dashboard/service role). The blanket GRANT ALL handed `authenticated`/`anon`
-- SELECT/UPDATE/DELETE too — only blocked today by the absence of policies. Revoke
-- them at the privilege level as well (defense in depth) and keep INSERT for
-- authenticated only.

alter table public.app_logs enable row level security;

-- Device insert path: append your OWN rows only.
drop policy if exists app_logs_insert_own on public.app_logs;
create policy app_logs_insert_own on public.app_logs
  for insert to authenticated
  with check (auth.uid() = user_id);

-- Privilege floor: no read/mutate for anon or authenticated; authenticated may
-- only INSERT (RLS still constrains it to auth.uid() = user_id). service_role
-- keeps full access (it bypasses RLS and is the owner's query path).
revoke all on public.app_logs from anon;
revoke all on public.app_logs from authenticated;
grant insert on public.app_logs to authenticated;
grant all on public.app_logs to service_role;
