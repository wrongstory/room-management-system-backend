-- PRODUCTION aodikrxcczbogjpsjwjt only. Exact one-run DB approval required.
-- Install DISABLED. No provider sends, Vault key creation/rotation or job activation.
BEGIN;
SET LOCAL statement_timeout = '15s';
SET LOCAL lock_timeout = '3s';
DO $preflight$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname='pg_net')
    OR NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname='pg_cron') THEN
    RAISE EXCEPTION 'DELIVERY_SCHEDULER_EXTENSIONS_REQUIRED';
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname='notification-delivery')
    OR to_regprocedure('private.invoke_notification_delivery_signed()') IS NOT NULL THEN
    RAISE EXCEPTION 'DELIVERY_SCHEDULER_EXISTS_REVIEW_BEFORE_RETRY';
  END IF;
  IF (SELECT count(*) FROM vault.secrets WHERE name='notification_delivery_invoke')<>1 THEN
    RAISE EXCEPTION 'DELIVERY_INVOKE_KEY_REQUIRED';
  END IF;
END
$preflight$;
CREATE FUNCTION private.invoke_notification_delivery_signed() RETURNS bigint
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $function$
DECLARE invoke_key text; at_seconds text; nonce text; signature text; request_id bigint;
BEGIN
  SELECT decrypted_secret INTO STRICT invoke_key FROM vault.decrypted_secrets
    WHERE name='notification_delivery_invoke';
  IF octet_length(invoke_key) NOT BETWEEN 32 AND 4096 OR invoke_key ~ '^[[:space:]]|[[:space:]]$' THEN
    RAISE EXCEPTION 'DELIVERY_INVOKE_KEY_INVALID';
  END IF;
  at_seconds:=floor(extract(epoch FROM clock_timestamp()))::bigint::text;
  nonce:=encode(extensions.gen_random_bytes(16),'hex');
  signature:=encode(extensions.hmac(convert_to('rms-scheduled-invocation-v1'||E'\n'||
    'notification-delivery:aodikrxcczbogjpsjwjt'||E'\n'||at_seconds||E'\n'||nonce||E'\nPOST','UTF8'),
    convert_to(invoke_key,'UTF8'),'sha256'),'hex');
  SELECT net.http_post(
    url:='https://aodikrxcczbogjpsjwjt.supabase.co/functions/v1/notification-delivery',
    headers:=jsonb_build_object('Content-Type','application/json','x-rms-invoke-at',at_seconds,
      'x-rms-invoke-nonce',nonce,'x-rms-invoke-signature',signature),
    body:=NULL::jsonb, timeout_milliseconds:=55000
  ) INTO request_id;
  RETURN request_id;
END
$function$;
REVOKE ALL ON FUNCTION private.invoke_notification_delivery_signed() FROM PUBLIC,anon,authenticated,service_role;
DO $schedule$
DECLARE job_id bigint;
BEGIN
  job_id:=cron.schedule('notification-delivery','* * * * *','select private.invoke_notification_delivery_signed();');
  PERFORM cron.alter_job(job_id,active:=false);
END
$schedule$;
COMMIT;
-- Enable only after approved exact worker/config, empty-body hosted smoke and target review.
-- Activation and retries require their own exact approved execution scope.
