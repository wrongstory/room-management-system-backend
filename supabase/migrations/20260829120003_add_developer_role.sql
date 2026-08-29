-- The developer account is a singleton platform operator, distinct from
-- business administrators. Keep the enum addition in its own migration so the
-- new value is committed before subsequent objects use it.
alter type public.app_role add value if not exists 'developer' before 'admin';
