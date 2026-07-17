-- Onboarding: track whether an org's owner has seen the first-run "design your
-- walkthrough form & report" guidance. Org-level (not per-user) and one-way:
-- set once, never reshown — even if the walkthrough form is later deleted, or a
-- different member signs in. The owner writes it through the existing
-- org_update_owner RLS policy (auth_uid_owns_org); no new policy needed.

alter table public.organizations
  add column if not exists has_seen_walkthrough_intro boolean not null default false;

-- Explicit column UPDATE grant so the owner can flip the flag regardless of
-- whether organizations' write grants are table- or column-scoped. SELECT is
-- already covered by the table-level grant + org_select_own RLS.
grant update (has_seen_walkthrough_intro) on public.organizations to authenticated;
