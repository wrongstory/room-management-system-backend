import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  assertAvailabilityRaceNotifications, availabilityRaceWriteMode, isExpectedAvailabilityCommitCollision, pastAvailableDatesForApproval,
} from '../scripts/lib/availability-race-fixture.mjs';

const read = path => readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
const week = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08'];

describe('#559 current-week availability fixtures (no DB)', () => {
  it.each(week)('preserves all original past true days and removes today/future on %s', today => {
    const result = pastAvailableDatesForApproval('2026-11-02', today);
    for (const day of week) expect(result.includes(day)).toBe(day < today);
    expect(new Set(result).size).toBe(result.length);
    expect(result).not.toContain(today);
  });

  it('handles Sunday to Monday and month/year rollover without carrying the old week', () => {
    expect(pastAvailableDatesForApproval('2026-11-02', '2026-11-08')).toEqual(week.slice(0, 6));
    expect(pastAvailableDatesForApproval('2026-11-09', '2026-11-09')).toEqual([]);
    expect(pastAvailableDatesForApproval('2026-11-30', '2026-12-01')).toEqual(['2026-11-30']);
    expect(pastAvailableDatesForApproval('2026-12-28', '2027-01-01')).toEqual(['2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31']);
    expect(() => pastAvailableDatesForApproval('2026-11-02', '2026-11-09')).toThrow('week changed');
  });

  it.each([
    ['2026-11-03', '2026-11-04'], ['2026-11-02', '2026-11-01'],
    ['2026-02-30', '2026-03-01'], ['2026-11-02', '2026-11-31'], ['invalid', '2026-11-02'],
  ])('rejects malformed dates or a mismatched week (%s, %s)', (start, today) => {
    expect(() => pastAvailableDatesForApproval(start, today)).toThrow();
  });

  it.each([
    ['2026-11-02', '2026-11-02T00:00:00.000Z', 'approve_current_week'],
    ['2026-11-02', '2026-11-04T03:00:00.000Z', 'approve_current_week'],
    ['2026-11-09', '2026-11-07T15:00:00.000Z', 'submit_next_week'],
    ['2026-11-09', '2026-11-08T14:59:59.999Z', 'submit_next_week'],
    ['2026-11-09', '2026-11-08T15:00:00.000Z', 'approve_current_week'],
    ['2027-01-04', '2027-01-03T14:59:59.999Z', 'submit_next_week'],
    ['2027-01-04', '2027-01-03T15:00:00.000Z', 'approve_current_week'],
  ])('selects the real KST week route for %s at %s', (start, at, expected) => {
    expect(availabilityRaceWriteMode(start, new Date(at))).toBe(expected);
  });

  it('rejects wrong-week fixtures and invalid clocks instead of choosing a permissive command', () => {
    for (const start of ['2026-10-26', '2026-11-16', '2026-11-03']) {
      expect(() => availabilityRaceWriteMode(start, new Date('2026-11-04T03:00:00Z'))).toThrow('outside');
    }
    expect(() => availabilityRaceWriteMode('2026-11-02', new Date('invalid'))).toThrow('clock');
    expect(() => availabilityRaceWriteMode('2026-11-02', '2026-11-04')).toThrow('clock');
  });

  const success = { data: {}, error: null };
  const collision = { data: null, error: { code: '40001', message: 'ASSIGNMENT_AVAILABILITY_STALE' } };
  it('requires the availability writer to reach the already-notified assignment guard', () => {
    expect(isExpectedAvailabilityCommitCollision([success, collision])).toBe(true);
    expect(isExpectedAvailabilityCommitCollision([collision, success])).toBe(false);
    expect(isExpectedAvailabilityCommitCollision([success, success])).toBe(false);
    expect(isExpectedAvailabilityCommitCollision([collision, collision])).toBe(false);
    expect(isExpectedAvailabilityCommitCollision([undefined, collision])).toBe(false);
    expect(isExpectedAvailabilityCommitCollision([success])).toBe(false);
  });

  it.each([
    ['22023', 'AVAILABILITY_WEEK_OUT_OF_RANGE'], ['42501', 'AVAILABILITY_APPROVAL_REQUIRED'],
    ['22023', 'PAST_AVAILABILITY_DATE_NOT_ALLOWED'], ['40001', 'STALE_VERSION'],
    ['42501', 'ACTIVE_ACCOUNT_REQUIRED'], ['40001', 'ASSIGNMENT_AVAILABILITY_STALE extra'],
    ['XX000', 'ASSIGNMENT_AVAILABILITY_STALE'],
  ])('never counts unrelated error %s / %s as the race loser', (code, message) => {
    expect(isExpectedAvailabilityCommitCollision([success, { error: { code, message } }])).toBe(false);
  });

  const noticeContext = { approvalSucceeded: true, maidProfileId: 'maid-owner', changeRequestId: 'winning-request' };
  const approvalNotice = {
    recipient_profile_id: noticeContext.maidProfileId,
    event_family: 'availability.change_approved',
    deep_link_kind: 'availabilityRequest',
    deep_link_entity_id: noticeContext.changeRequestId,
  };
  it('requires one correctly routed approval notice for a winner and rejects missing or duplicate notices', () => {
    expect(() => assertAvailabilityRaceNotifications([approvalNotice], noticeContext)).not.toThrow();
    expect(() => assertAvailabilityRaceNotifications([], noticeContext)).toThrow('exactly');
    expect(() => assertAvailabilityRaceNotifications([approvalNotice, approvalNotice], noticeContext)).toThrow('exactly');
  });
  it('requires the losing approval transaction to emit no notice', () => {
    const loser = { ...noticeContext, approvalSucceeded: false };
    expect(() => assertAvailabilityRaceNotifications([], loser)).not.toThrow();
    expect(() => assertAvailabilityRaceNotifications([approvalNotice], loser)).toThrow('exactly');
  });
  it.each([
    ['recipient_profile_id', 'another-maid'], ['event_family', 'availability.change_rejected'],
    ['deep_link_kind', 'cleaningTarget'], ['deep_link_entity_id', 'another-request'],
  ])('rejects a winner notice with incorrect %s', (field, value) => {
    expect(() => assertAvailabilityRaceNotifications([{ ...approvalNotice, [field]: value }], noticeContext)).toThrow();
  });
  it('rejects missing query results and unknown race outcomes instead of assuming zero notices', () => {
    for (const value of [null, undefined, {}]) {
      expect(() => assertAvailabilityRaceNotifications(value, noticeContext)).toThrow('array');
    }
    expect(() => assertAvailabilityRaceNotifications([], { ...noticeContext, approvalSucceeded: undefined })).toThrow('outcome');
  });

  it('keeps ended-assignment SQL on the approved request path with the same actor/date/version oracle', () => {
    const source = read('supabase/tests/cleaning_overdue_commit.sql');
    const line = source.split('\n').find(value => value.includes("'ended assignments do not leave a ghost today guard'"));
    expect(line).toContain('private.decide_availability_change_at(pg_temp.ocid(1),(private.request_availability_change_at(pg_temp.ocid(3)');
    expect(line).toContain("'2038-06-07',array['2038-06-08'::date],'WORK_SCHEDULE',2,'overdue-ended-unavailable-request','2038-06-07 09:00+09'");
    expect(line).toContain("'approved','ADMIN_APPROVED',2,'overdue-ended-unavailable','2038-06-07 09:00+09'");
    expect(line).not.toContain('submit_weekly_availability_at');
  });

  it('wires past-date preservation into the original real approval lock race', () => {
    const source = read('scripts/test-attempt-lifecycle-concurrency.mjs');
    expect(source).toContain('requested_available_dates: pastAvailableDatesForApproval(availabilityWeek, day)');
    expect(source).toContain("await waitForLock('manage_cleaning_attempt_lifecycle')");
    expect(source).toContain("await releaseApproval(`select public.decide_availability_change('");
    expect(source).toContain("result.error?.message === 'ASSIGNMENT_MAID_UNAVAILABLE'");
    expect(source).toContain("set local statement_timeout='12s'; set local idle_in_transaction_session_timeout='15s'");
  });

  it('retains tomorrow/future checkout dates and one availability RPC in the commit race', () => {
    const source = read('scripts/test-reservation-concurrency.mjs');
    expect(source).toContain('assignmentCommitDate.setUTCDate(assignmentCommitDate.getUTCDate() + 1)');
    expect(source).toMatch(/const planningCheckOut = `\$\{assignmentCommitServiceDate\}T11:00:00\+09:00`/);
    const race = source.match(/const availabilityRace = await Promise\.all\(\[([\s\S]*?)\n\]\);/)[1];
    expect(race).toContain("availabilityWriteMode === 'approve_current_week' ? client.rpc('decide_availability_change'");
    expect(race).toContain("}) : client.rpc('submit_weekly_availability', {\n    p_actor_profile_id: logicalAccountId");
    expect(race).toContain('p_change_request_id: changeRequestId');
    expect(race).toContain('p_available_dates: requestedAvailabilityDates');
    expect(source).toContain('assert(isExpectedAvailabilityCommitCollision(availabilityRace)');
    expect(source).toContain("'availability fixture week must not change between preparation and the race'");
  });
});
