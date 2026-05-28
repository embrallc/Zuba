-- ─────────────────────────────────────────────────────────────────────────────
-- route_cache: per-user-per-day cached response from the my-day-route Edge
-- Function. Keeps upstream Google Routes API spend bounded by serving the
-- cached payload to subsequent dashboard fetches within the TTL window.
--
-- Cache invalidation is fingerprint-based: the Edge Function recomputes a
-- hash of (inspection_sk + scheduled_at + address) on every call and only
-- returns cached data when both the fingerprint matches AND expires_at is
-- in the future. Mid-day cancellation, reschedule, add — all flip the
-- fingerprint and force a fresh Routes API call.
--
-- RLS: locked down completely. Only the service role (used by the Edge
-- Function) can read/write. Clients never query this table directly.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS route_cache (
  cache_key    TEXT PRIMARY KEY NOT NULL,
  user_id      UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  payload      JSONB NOT NULL,
  fingerprint  TEXT NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_route_cache_user_id
  ON route_cache(user_id);
CREATE INDEX IF NOT EXISTS idx_route_cache_expires_at
  ON route_cache(expires_at);

-- RLS enabled with no policies → service role bypasses, anon/authed get
-- nothing. This is the lockdown pattern.
ALTER TABLE route_cache ENABLE ROW LEVEL SECURITY;
