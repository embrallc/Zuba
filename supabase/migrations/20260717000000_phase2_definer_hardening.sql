-- Phase-2 security hardening — Supabase Security Advisor follow-up to the SEV-0
-- lockdown (20260716000100). None of these were exploitable; this clears the
-- remaining advisor WARNs and applies least privilege.
--
--   A. function_search_path_mutable — pin search_path on the flagged
--      SECURITY DEFINER (and two trigger) functions so a caller's session
--      search_path can't influence name resolution inside them. Every body is
--      already fully schema-qualified (verified against the live definitions),
--      so search_path = '' is safe; the lone exception (auth_uid_is_org_owner_of,
--      which referenced `users` unqualified) is recreated with public.users.
--
--   B. anon/authenticated_security_definer_function_executable — revoke EXECUTE
--      on the trigger/event-trigger definer functions (they fire via triggers
--      and never need a direct grant), and drop anon from the auth_uid_* RLS
--      helpers. authenticated MUST keep EXECUTE on the helpers — the RLS
--      policies call them — so those stay (and remain intentionally flagged),
--      as do the three org/role-scoped app RPCs from the SEV-0 fix.
--
-- Idempotent + env-safe via to_regprocedure guards.

-- ── A1. Recreate the one function with an unqualified reference, pinned ──────
create or replace function public.auth_uid_is_org_owner_of(target_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from   public.users me
    join   public.users target on target.id = target_user_id
    where  me.id           = auth.uid()
      and  me.user_profile = 'owner'
      and  me.org_sk       is not null
      and  me.org_sk       = target.org_sk
  );
$$;

-- ── A2. Pin search_path on the remaining flagged functions (bodies already
--        fully qualified — metadata-only change, no body rewrite) ────────────
do $$
declare fn text;
begin
  foreach fn in array array[
    'public.auth_uid_can_view_org_of(uuid)',
    'public.auth_uid_org_sk()',
    'public.auth_uid_owns_org(uuid)',
    'public.delete_org_cascade(uuid)',
    'public.delete_user_orphan(uuid)',
    'public.enforce_user_role_change()',
    'public.handle_new_user()',
    'public.inspections_set_org_sk()',
    'public.list_all_org_inspections()',
    'public.list_unassigned_inspections()',
    'public.reassign_inspection(text, uuid)',
    'public.set_server_updated_at()',
    'public.rearm_appt_reminder()'
  ] loop
    if to_regprocedure(fn) is not null then
      execute format('alter function %s set search_path = %L', fn, '');
    end if;
  end loop;
end $$;

-- ── B1. Revoke EXECUTE on trigger / event-trigger functions from every API
--        role — they fire from triggers, which never consult EXECUTE grants ──
do $$
declare fn text;
begin
  foreach fn in array array[
    'public.handle_new_user()',
    'public.enforce_user_role_change()',
    'public.inspections_set_org_sk()',
    'public.rls_auto_enable()',
    'public.set_server_updated_at()',
    'public.rearm_appt_reminder()'
  ] loop
    if to_regprocedure(fn) is not null then
      execute format('revoke execute on function %s from public, anon, authenticated', fn);
    end if;
  end loop;
end $$;

-- ── B2. Drop anon from the auth_uid_* RLS helpers (authenticated keeps its
--        explicit grant — the RLS policies invoke these during queries) ──────
do $$
declare fn text;
begin
  foreach fn in array array[
    'public.auth_uid_can_view_org_of(uuid)',
    'public.auth_uid_is_org_owner_of(uuid)',
    'public.auth_uid_org_sk()',
    'public.auth_uid_owns_org(uuid)'
  ] loop
    if to_regprocedure(fn) is not null then
      execute format('revoke execute on function %s from public, anon', fn);
    end if;
  end loop;
end $$;
