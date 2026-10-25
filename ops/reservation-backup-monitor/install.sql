-- RECOVERY PROJECT ONLY: matalcofimnhuzslfhdd. Requires a fresh explicit approval.
-- The reviewed installer must pin the Management API target to this recovery project.
-- No production migration, backup plaintext, DB password, encryption key or GitHub token.
BEGIN;
SET LOCAL statement_timeout = '30s';
SET LOCAL lock_timeout = '5s';
DO $preflight$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'reservation-backups' AND NOT public) THEN
    RAISE EXCEPTION 'RECOVERY_BACKUP_BUCKET_REQUIRED';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'backup_ops') THEN
    RAISE EXCEPTION 'BACKUP_MONITOR_ALREADY_INSTALLED_REVIEW_BEFORE_RETRY';
  END IF;
END
$preflight$;
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;
CREATE SCHEMA backup_ops AUTHORIZATION postgres;
REVOKE ALL ON SCHEMA backup_ops FROM PUBLIC, anon, authenticated, service_role;
DO $secret$
BEGIN
  IF EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'reservation_backup_monitor_invoke') THEN
    RAISE EXCEPTION 'BACKUP_MONITOR_SECRET_EXISTS_REVIEW_BEFORE_RETRY';
  END IF;
  PERFORM vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'),
    'reservation_backup_monitor_invoke', 'Only invokes the recovery backup status monitor');
END
$secret$;
CREATE FUNCTION backup_ops.invoke_reservation_backup_monitor() RETURNS bigint
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $function$
DECLARE invoke_key text; request_id bigint; at_seconds text; nonce text; signature text;
BEGIN
  SELECT decrypted_secret INTO STRICT invoke_key FROM vault.decrypted_secrets
    WHERE name = 'reservation_backup_monitor_invoke';
  IF invoke_key !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'BACKUP_MONITOR_KEY_INVALID'; END IF;
  at_seconds:=floor(extract(epoch FROM clock_timestamp()))::bigint::text;
  nonce:=encode(extensions.gen_random_bytes(16),'hex');
  -- Reuse the already configured private SHA256 key digest as a derived signing key.
  -- The digest is now an authentication key: never expose it as public metadata.
  signature:=encode(extensions.hmac(convert_to('rms-scheduled-invocation-v1'||E'\n'||
    'reservation-backup-monitor:matalcofimnhuzslfhdd'||E'\n'||at_seconds||E'\n'||nonce||E'\nPOST','UTF8'),
    extensions.digest(convert_to(invoke_key,'UTF8'),'sha256'),'sha256'),'hex');
  SELECT net.http_post(
    url := 'https://matalcofimnhuzslfhdd.supabase.co/functions/v1/reservation-backup-monitor',
    headers := jsonb_build_object('Content-Type','application/json','x-rms-invoke-at',at_seconds,
      'x-rms-invoke-nonce',nonce,'x-rms-invoke-signature',signature),
    body := '{}'::jsonb, timeout_milliseconds := 120000
  ) INTO request_id;
  RETURN request_id;
END
$function$;
REVOKE ALL ON FUNCTION backup_ops.invoke_reservation_backup_monitor() FROM PUBLIC, anon, authenticated, service_role;
DO $schedule$
DECLARE job_id bigint;
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'reservation-backup-monitor') THEN
    RAISE EXCEPTION 'BACKUP_MONITOR_JOB_EXISTS_REVIEW_BEFORE_RETRY';
  END IF;
  -- UTC hourly :17, after 03:00 KST backup; evaluator applies a 04:00 KST deadline.
  job_id := cron.schedule('reservation-backup-monitor', '17 * * * *',
    'select backup_ops.invoke_reservation_backup_monitor();');
  PERFORM cron.alter_job(job_id, active := false);
END
$schedule$;
COMMIT;

-- Activation is separate and only after the Edge function + actual alert delivery pass.
-- select cron.alter_job(job_id := (select jobid from cron.job where jobname = 'reservation-backup-monitor'), active := true);
-- Pause only this job for rollback; preserve validated backups and unrelated cron jobs.
