-- ─────────────────────────────────────────────────────────────────────────────
-- Update handle_new_user: write org_sk + user_profile back into
-- raw_user_meta_data so the client can read them from the auth session
-- without an extra round-trip.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_org_sk      UUID;
  v_org_sk_raw  TEXT;
  v_company     TEXT;
  v_user_profile TEXT;
BEGIN
  v_company    := NEW.raw_user_meta_data ->> 'company_name';
  v_org_sk_raw := NEW.raw_user_meta_data ->> 'org_sk';

  IF v_company IS NOT NULL AND v_company <> '' THEN
    -- ── Owner flow ────────────────────────────────────────────────────────
    v_user_profile := 'owner';

    INSERT INTO public.organizations (org_name, user_id)
    VALUES (v_company, NEW.id)
    RETURNING org_sk INTO v_org_sk;

    INSERT INTO public.users (id, user_sk, org_sk, user_profile)
    VALUES (NEW.id, NEW.id, v_org_sk, v_user_profile);

  ELSIF v_org_sk_raw IS NOT NULL AND v_org_sk_raw <> '' THEN
    -- ── Member flow ───────────────────────────────────────────────────────
    v_user_profile := 'member';

    BEGIN
      v_org_sk := v_org_sk_raw::UUID;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'Organization does not exist, please check the ID you are entering.';
    END;

    IF NOT EXISTS (
      SELECT 1 FROM public.organizations WHERE org_sk = v_org_sk
    ) THEN
      RAISE EXCEPTION 'Organization does not exist, please check the ID you are entering.';
    END IF;

    INSERT INTO public.users (id, user_sk, org_sk, user_profile)
    VALUES (NEW.id, NEW.id, v_org_sk, v_user_profile);

  ELSE
    RAISE EXCEPTION 'Sign-up requires either a company name (new organization) or an organization ID (joining existing).';
  END IF;

  -- Write org_sk and user_profile back into auth metadata so the client
  -- can read them from supabase.auth.getUser() without a separate query.
  UPDATE auth.users
  SET raw_user_meta_data = raw_user_meta_data ||
    jsonb_build_object('org_sk', v_org_sk::TEXT, 'user_profile', v_user_profile)
  WHERE id = NEW.id;

  RETURN NEW;
END;
$$;
