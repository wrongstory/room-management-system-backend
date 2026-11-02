# Worker admission source contract — #396

This is source preparation, not production activation or proof that reset is safe.
Source132 integrates the notification worker on Node and Edge. The reservation
scheduler, PIN Sheet worker, photo purge, external operators and full coverage
readback remain separate work. The existing photo deletion HOLD and disabled PIN
full resync are unchanged. No real DB, Auth, push provider or TLS connection was
used to validate this unit.

## Activation and trust

`NOTIFICATION_OPERATION_ADMISSION_MODE` is absent/`disabled` by default. Explicit
`required` additionally needs `DEVELOPER_OPERATION_TARGET` equal to the trusted
`SUPABASE_URL` project. This only selects the wrapper; it does not create a
control row, choose a reauthentication TTL, start operations, schedule a worker,
or authorize reset. A missing control row preserves the existing workload and
is **not** readiness evidence. Initial control installation requires independently
verified ingress stop and completion of previously untracked work.

Service-only wrappers trust the reviewed runtime and existing typed provider
settlement path. A caller Boolean/HTTP response/owner receipt is not independent
provider evidence or proof of human approval. Direct owner SQL or uninstrumented
service calls remain outside this integration; runtime/deployment identity,
every write entry point, scheduler configuration and operator paths must be
accounted for before global coverage can be accepted.

## Actual execution boundary

`claim_operation_notification_deliveries` locks the control row and creates an
admission in the same transaction as the original claim. It stores the exact
immutable attempt ID, target ID, lease version and claim digest for each item.
It does not store subscription data, credentials, PINs, payloads or request bodies.
The claim digest is unique across notification admissions, so a second run cannot
reuse one attempt/fence and borrow the first run's future terminal receipt.
Configured requested maintenance rejects the claim before workload mutation.

The request-scoped Node/Edge RPC adapter permits one claim and only the existing
envelope, permit, settle and heartbeat calls. A rejected or unobserved claim
blocks all subsequent calls, including the legacy fallback failure heartbeat.
Configuration failures before a claim use a separate fixed same-transaction
heartbeat wrapper. Its acquire/write/complete rollback together on failure.
The existing 45-second worker run budget bounds observation; it is neither a
new policy TTL nor evidence that a timed-out effect stopped.

After the whole worker returns, `complete_operation_notification_deliveries`
reads each captured attempt's immutable completed result. It accepts known
terminal accepted/suppressed/endpoint-gone/payload-rejected/configuration-error
results. Acceptance means the push provider responded; it does not prove a
person received or read a notification. Retryable results, including network
errors and timeouts, remain unresolved even if a later attempt delivers the
same target. Lease expiry, a newer fence, current target terminal state, pending
count zero and a successful HTTP response never clear an older unknown attempt.

The worker only requests completion after its final heartbeat resolved. Runtime
failure or response loss keeps the admission open. A completion-response loss
can leave an already completed DB row; the row is authoritative, not a local
timeout. Automated retries do not repeat an ambiguous provider call under an
assumed empty lease. Owner reconciliation and runtime termination evidence for
unknown effects require a separate reviewed procedure; no automatic clearance
is implemented here. Completed receipt retention/deletion also needs a reviewed
policy; this unit does not add one.

## Verification boundaries

Runtime tests use fake RPC/provider ports and the actual Node/Edge workers.
Negative cases include failed claim followed by fallback heartbeat, malformed
claim envelopes, extra RPCs, repeated claims, expired observation and a DB
refusal to verify an otherwise successful worker. Source tests parse PostgreSQL
15/17 syntax without a connection. `supabase/tests/operation_worker_admission.sql`
prepares rollback-only cases for exact attempt matching, requested maintenance,
pre-claim heartbeat and later-success/earlier-unknown separation. These SQL
fixtures have **not** run. Their execution is part of the separately approved
final DB validation; syntax parsing is not PL/pgSQL or concurrency validation.

Source validation on 2026-10-25: `npm run ci:quality` PASS (170 files / 4,709
tests), `npm run edge:check` PASS (65 / 554 / 68 tests; report 19,877,020 bytes,
backup monitor 99,006 bytes), migration manifest132 and generated helper checks
PASS. The first Edge attempt failed formatting on four new/changed files; the
pinned Deno formatter repaired only those sources and the complete check was
rerun. The initial lazy builder lint diagnostic was resolved with a specific
documented thenable exception, retaining actual Promise/abort behavior. No test
was removed or skipped to obtain these results. Actual DB/TLS/provider execution
and production activation remain NOT RUN.
