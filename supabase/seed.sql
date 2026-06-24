-- ─────────────────────────────────────────────────────────────────────────────
-- LOCAL-ONLY seed. Runs after migrations on `supabase db reset` (db.seed in
-- config.toml). NEVER runs against cloud projects — `db push` does not apply
-- seeds. Gives a ready-to-use owner account + a little sample data so the app
-- works against the local stack immediately.
--
--   Login:  dev@zuba.test  /  password123
--
-- Wrapped in a DO block with exception handling so any version-specific hiccup
-- (auth schema differences, etc.) logs a NOTICE instead of aborting the whole
-- reset. If the seed user doesn't appear, just sign up through the app against
-- local — the real signup flow exercises the same triggers.
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_user_id UUID := '11111111-1111-1111-1111-111111111111';
  v_org_sk  UUID;
BEGIN
  -- Owner auth user. The handle_new_user trigger reads company_name from
  -- raw_user_meta_data and creates the organization + public.users (owner) row.
  INSERT INTO auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at,
    raw_app_meta_data, raw_user_meta_data
  )
  VALUES (
    '00000000-0000-0000-0000-000000000000',
    v_user_id, 'authenticated', 'authenticated', 'dev@zuba.test',
    extensions.crypt('password123', extensions.gen_salt('bf')),
    now(), now(), now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"company_name":"Test Inspections"}'::jsonb
  )
  ON CONFLICT (id) DO NOTHING;

  -- Email identity — required for password sign-in on recent GoTrue.
  INSERT INTO auth.identities (
    id, user_id, identity_data, provider, provider_id,
    last_sign_in_at, created_at, updated_at
  )
  VALUES (
    gen_random_uuid(), v_user_id,
    jsonb_build_object('sub', v_user_id::text, 'email', 'dev@zuba.test'),
    'email', v_user_id::text, now(), now(), now()
  )
  ON CONFLICT (provider, provider_id) DO NOTHING;

  -- Ownership lives on public.users (organizations.user_id was dropped); read
  -- the org the handle_new_user trigger just created from there.
  SELECT org_sk INTO v_org_sk
    FROM public.users WHERE id = v_user_id;

  -- A couple of OPEN inspections so the list/calendar isn't empty. org_sk is
  -- set automatically by the inspections_set_org_sk trigger; status defaults to
  -- 'OPEN'. (No walkthrough form seeded — build one in-app.)
  INSERT INTO public.inspections
    (inspection_sk, user_id, full_name, address_line1, city, state, zip_code, scheduled_at)
  VALUES
    ('seed-insp-0001', v_user_id, 'Jane Homeowner', '123 Main St',  'Springfield', 'MO', '65801', now() + interval '1 day'),
    ('seed-insp-0002', v_user_id, 'John Renter',    '456 Oak Ave',  'Springfield', 'MO', '65802', now() + interval '3 days')
  ON CONFLICT (inspection_sk) DO NOTHING;

  RAISE NOTICE 'Seed OK: dev@zuba.test / password123 (org %)', v_org_sk;
EXCEPTION WHEN others THEN
  RAISE NOTICE 'Seed skipped/partial: %', SQLERRM;
END $$;
