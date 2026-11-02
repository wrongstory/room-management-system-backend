-- PRODUCTION aodikrxcczbogjpsjwjt only. Exact one-run DB approval required.
-- Creates a callable helper only; does not modify/activate/pause the existing Cron.
BEGIN;
SET LOCAL statement_timeout = '15s';
SET LOCAL lock_timeout = '3s';
DO $preflight$
BEGIN
  IF (SELECT count(*) FROM vault.secrets WHERE name='scheduler_invoke_secret')<>1
    OR NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname='pg_net') THEN
    RAISE EXCEPTION 'SIGNED_SCHEDULER_REQUIREMENTS_MISSING';
  END IF;
  IF to_regprocedure('private.invoke_reservation_scheduler_signed()') IS NOT NULL THEN
    RAISE EXCEPTION 'SIGNED_SCHEDULER_EXISTS_REVIEW_BEFORE_RETRY';
  END IF;
END
$preflight$;
CREATE FUNCTION private.invoke_reservation_scheduler_signed() RETURNS bigint
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $function$
DECLARE invoke_key text; at_seconds text; nonce text; signature text; request_id bigint;
BEGIN
  SELECT decrypted_secret INTO STRICT invoke_key FROM vault.decrypted_secrets WHERE name='scheduler_invoke_secret';
  IF octet_length(invoke_key) NOT BETWEEN 32 AND 4096 OR invoke_key ~ '^[[:space:]]|[[:space:]]$' THEN
    RAISE EXCEPTION 'SCHEDULER_INVOKE_KEY_INVALID';
  END IF;
  at_seconds:=floor(extract(epoch FROM clock_timestamp()))::bigint::text;
  nonce:=encode(extensions.gen_random_bytes(16),'hex');
  signature:=encode(extensions.hmac(convert_to('rms-scheduled-invocation-v1'||E'\n'||
    'reservation-scheduler:aodikrxcczbogjpsjwjt'||E'\n'||at_seconds||E'\n'||nonce||E'\nPOST','UTF8'),
    convert_to(invoke_key,'UTF8'),'sha256'),'hex');
  SELECT net.http_post(
    url:='https://aodikrxcczbogjpsjwjt.supabase.co/functions/v1/reservation-scheduler',
    headers:=jsonb_build_object('Content-Type','application/json','x-rms-invoke-at',at_seconds,
      'x-rms-invoke-nonce',nonce,'x-rms-invoke-signature',signature),
    body:='{}'::jsonb, timeout_milliseconds:=55000
  ) INTO request_id;
  RETURN request_id;
END
$function$;
REVOKE ALL ON FUNCTION private.invoke_reservation_scheduler_signed() FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
-- Approved cutover must pause the exact existing Cron, configure signed-v1, validate
-- the exact command once and change/resume that same job. No unreviewed fallback or retry.
