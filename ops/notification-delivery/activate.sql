-- PRODUCTION aodikrxcczbogjpsjwjt only. Exact one-run activation approval required.
-- Run only after signed hosted smoke. No new notifications or historical replay.
BEGIN;
SET LOCAL statement_timeout='15s';
SET LOCAL lock_timeout='3s';
DO $activation$
DECLARE job_id bigint;
BEGIN
  SELECT jobid INTO STRICT job_id FROM cron.job
    WHERE jobname='notification-delivery' AND schedule='* * * * *' AND NOT active
      AND command='select private.invoke_notification_delivery_signed();';
  IF NOT EXISTS (SELECT 1 FROM private.notification_delivery_heartbeat
    WHERE singleton AND status='succeeded' AND recorded_at>clock_timestamp()-interval '5 minutes') THEN
    RAISE EXCEPTION 'DELIVERY_RECENT_SUCCESS_REQUIRED';
  END IF;
  IF EXISTS (SELECT 1 FROM private.notification_delivery_jobs WHERE status IN ('pending','dead_letter','operator_blocked'))
    OR EXISTS (SELECT 1 FROM private.notification_delivery_targets WHERE status IN ('pending','claimed','retry','dead_letter','operator_blocked')) THEN
    RAISE EXCEPTION 'DELIVERY_QUEUE_REVIEW_REQUIRED';
  END IF;
  PERFORM cron.alter_job(job_id,active:=true);
END
$activation$;
COMMIT;
