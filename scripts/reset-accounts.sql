BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '10s';
SET LOCAL lock_timeout = '2s';
SET LOCAL search_path = pg_catalog;

-- Only aggregate counts leave the database. No credential or identity values.
SELECT jsonb_build_object(
  'format', 'reset-accounts-v2',
  'readOnly', current_setting('transaction_read_only') = 'on',
  'profiles', count(*),
  'developers', count(*) FILTER (WHERE p.role = 'developer'),
  'eligibleDevelopers', count(*) FILTER (WHERE p.role = 'developer'
    AND p.status = 'active' AND p.deactivated_at IS NULL
    AND p.login_id = 'admin' AND p.login_id_normalized = 'admin'
    AND NOT p.must_change_password
    AND (p.locked_until IS NULL OR p.locked_until <= transaction_timestamp())),
  'resetCandidates', count(*) FILTER (WHERE p.role IN ('admin', 'maid')),
  'otherProfiles', count(*) FILTER (WHERE p.role::text NOT IN ('developer', 'admin', 'maid')),
  'developerAuthLinks', count(*) FILTER (WHERE p.role = 'developer'
    AND EXISTS (SELECT 1 FROM auth.users u WHERE u.id = p.auth_user_id)),
  'developerLoginAliases', count(*) FILTER (WHERE p.role = 'developer'
    AND EXISTS (SELECT 1 FROM public.login_aliases a WHERE a.profile_id = p.id
      AND a.active AND a.alias_normalized = p.login_id_normalized
      AND NOT a.expires_after_new_login AND a.retired_at IS NULL)),
  'developerPasswordVersions', count(*) FILTER (WHERE p.role = 'developer'
    AND EXISTS (SELECT 1 FROM private.auth_password_versions v WHERE v.auth_user_id = p.auth_user_id)),
  'developerAliasRows', (SELECT count(*) FROM public.login_aliases a
    JOIN public.profiles d ON d.id = a.profile_id WHERE d.role = 'developer'),
  'missingAuthLinks', count(*) FILTER (WHERE NOT EXISTS (
    SELECT 1 FROM auth.users u WHERE u.id = p.auth_user_id)),
  'unlinkedAuthUsers', (SELECT count(*) FROM auth.users u WHERE NOT EXISTS (
    SELECT 1 FROM public.profiles q WHERE q.auth_user_id = u.id)),
  'unresolvedPasswordChanges', (SELECT count(*) FROM private.password_change_commands c
    WHERE c.state IN ('auth_pending', 'inconsistent', 'reset_pending')),
  'preparedPasswordResets', (SELECT count(*) FROM private.password_reset_auth_markers m
    WHERE m.state = 'prepared'),
  'developerCrossAccountMarkers', (SELECT count(*) FROM private.password_reset_auth_markers m
    JOIN public.profiles actor ON actor.id = m.actor_profile_id
    JOIN public.profiles target ON target.id = m.target_profile_id
    WHERE (actor.role = 'developer') <> (target.role = 'developer')),
  'developerCommandLinks', (
    (SELECT count(*) FROM private.password_change_commands c
      JOIN public.profiles owner ON owner.id = c.actor_profile_id
      WHERE owner.role = 'developer' AND c.reset_command_execution_id IS NOT NULL)
    + (SELECT count(*) FROM private.password_reset_auth_markers m
      JOIN public.profiles actor ON actor.id = m.actor_profile_id
      JOIN public.profiles target ON target.id = m.target_profile_id
      WHERE actor.role = 'developer' OR target.role = 'developer'))
)
FROM public.profiles p;
ROLLBACK;
