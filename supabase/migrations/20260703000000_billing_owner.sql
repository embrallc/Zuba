-- ─────────────────────────────────────────────────────────────────────────────
-- Billing owner: the ONE user in an org whose App Store / Play account pays.
--
-- Why: Apple/Google subscription-group dedup only works within a single Apple
-- ID. With multiple owners each logged into RevenueCat as themselves, two of
-- them "approving" a seat would create two real subscriptions billed to two
-- different accounts — nothing on our side or Apple's can dedup that. So we
-- funnel all seat purchases/upgrades/downgrades through a single designated
-- payer. Only they can approve teammates or change the plan; every other owner
-- sees a read-only "billing is handled by X" state.
--
-- The designation lives on the org. The FK is ON DELETE SET NULL, so when the
-- billing owner's account is deleted the org auto-blanks and an owner must pick
-- a new one (delete_user_orphan cascades public.users, which trips this).
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.organizations
  add column if not exists billing_owner_id uuid
    references public.users(id) on delete set null;

-- Backfill existing orgs: prefer an owner, fall back to an admin, oldest first.
update public.organizations o
set billing_owner_id = sub.id
from (
  select distinct on (u.org_sk)
    u.org_sk, u.id
  from public.users u
  where u.user_profile in ('owner', 'admin')
  order by u.org_sk,
           (u.user_profile = 'owner') desc,  -- owners before admins
           u.created_at asc                   -- then oldest account
) sub
where sub.org_sk = o.org_sk
  and o.billing_owner_id is null;

-- ── set_billing_owner: transfer / assign / clear the designation ─────────────
-- Authorization (enforced here, not in the client):
--   • Actor must be an OWNER, or the person who currently holds billing.
--   • Target must be an owner or admin in the caller's org (or NULL to clear).
-- SECURITY DEFINER so it can write organizations regardless of RLS, with the
-- checks above standing in for a policy.
create or replace function public.set_billing_owner(p_target_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller      uuid := auth.uid();
  v_caller_org  uuid;
  v_caller_role text;
  v_current     uuid;
  v_target_org  uuid;
  v_target_role text;
begin
  if v_caller is null then
    raise exception 'Not authenticated';
  end if;

  select org_sk, user_profile
    into v_caller_org, v_caller_role
    from public.users where id = v_caller;
  if v_caller_org is null then
    raise exception 'You are not part of an organization.';
  end if;

  select billing_owner_id into v_current
    from public.organizations where org_sk = v_caller_org;

  -- Actor gate: an owner, or the current billing owner (whatever their role).
  if not (v_caller_role = 'owner' or v_caller is not distinct from v_current) then
    raise exception 'Only an owner or the current billing owner can change who pays.';
  end if;

  -- Clearing is allowed — an owner reassigns it afterward.
  if p_target_user_id is null then
    update public.organizations
       set billing_owner_id = null
     where org_sk = v_caller_org;
    return;
  end if;

  select org_sk, user_profile
    into v_target_org, v_target_role
    from public.users where id = p_target_user_id;
  if v_target_org is null or v_target_org is distinct from v_caller_org then
    raise exception 'That user is not in your organization.';
  end if;
  if v_target_role not in ('owner', 'admin') then
    raise exception 'The billing owner must be an owner or admin.';
  end if;

  update public.organizations
     set billing_owner_id = p_target_user_id
   where org_sk = v_caller_org;
end;
$$;

grant execute on function public.set_billing_owner(uuid) to authenticated;
