-- ─────────────────────────────────────────────────────────────────────────────
-- Trigger: handle_new_user
--
-- Fires AFTER INSERT on auth.users.
-- Reads raw_user_meta_data to determine owner vs. member signup:
--
--   Owner  → company_name in metadata → creates organization (server UUID),
--            creates users row with user_profile = 'owner'
--
--   Member → org_sk in metadata → validates org exists,
--            creates users row with user_profile = 'member'
--
-- Any failure raises an exception, rolling back the auth.users insert so
-- no partial state is left behind.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_org_sk     UUID;
  v_org_sk_raw TEXT;
  v_company    TEXT;
BEGIN
  v_company    := NEW.raw_user_meta_data ->> 'company_name';
  v_org_sk_raw := NEW.raw_user_meta_data ->> 'org_sk';

  IF v_company IS NOT NULL AND v_company <> '' THEN
    -- ── Owner flow ────────────────────────────────────────────────────────
    INSERT INTO public.organizations (org_name, user_id)
    VALUES (v_company, NEW.id)
    RETURNING org_sk INTO v_org_sk;

    INSERT INTO public.users (id, user_sk, org_sk, user_profile)
    VALUES (NEW.id, NEW.id, v_org_sk, 'owner');

  ELSIF v_org_sk_raw IS NOT NULL AND v_org_sk_raw <> '' THEN
    -- ── Member flow ───────────────────────────────────────────────────────
    -- Cast to UUID — invalid format raises a clean error
    BEGIN
      v_org_sk := v_org_sk_raw::UUID;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'Organization does not exist, please check the ID you are entering.';
    END;

    -- Verify org exists
    IF NOT EXISTS (
      SELECT 1 FROM public.organizations WHERE org_sk = v_org_sk
    ) THEN
      RAISE EXCEPTION 'Organization does not exist, please check the ID you are entering.';
    END IF;

    INSERT INTO public.users (id, user_sk, org_sk, user_profile)
    VALUES (NEW.id, NEW.id, v_org_sk, 'member');

  ELSE
    RAISE EXCEPTION 'Sign-up requires either a company name (new organization) or an organization ID (joining existing).';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE PROCEDURE public.handle_new_user();
