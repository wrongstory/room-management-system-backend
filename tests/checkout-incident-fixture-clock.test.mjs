import {describe,expect,it} from 'vitest';
import {checkoutIncidentPlannedCheckoutAt} from '../scripts/test-checkout-incident-concurrency.mjs';
const kstDay=d=>new Date(d.getTime()+9*3600000).toISOString().slice(0,10);
const minute=d=>Math.floor(d.getTime()/60000)*60000;
describe('checkout incident manual fixture planning day',()=>{
 it.each(['2026-11-02T15:00:00Z','2026-11-03T03:00:00Z','2026-11-03T13:59:59Z'])('preserves the original full hour at %s',iso=>{
  const actual=new Date(iso);expect(checkoutIncidentPlannedCheckoutAt(actual,'manual').getTime()).toBe(actual.getTime()+3600000);
 });
 it.each(['2026-11-02T14:00:00Z','2026-11-02T14:51:20Z','2026-11-02T14:57:59Z','2026-12-31T14:51:20Z','2028-02-29T14:51:20Z'])('keeps late manual planning and activation on the actual KST day at %s',iso=>{
  const actual=new Date(iso);const planned=checkoutIncidentPlannedCheckoutAt(actual,'manual');
  expect(planned.toISOString().slice(11,16)).toBe('14:59');expect(kstDay(planned)).toBe(kstDay(actual));
  expect(minute(planned)).toBeGreaterThan(minute(actual));expect(kstDay(new Date(minute(actual)+60000))).toBe(kstDay(actual));
 });
 it('reproduces the old observed-time geometry without running a database',()=>{
  const actual=new Date('2026-11-02T14:51:20Z');const oldPlan=new Date(actual.getTime()+3600000);
  expect(kstDay(oldPlan)).toBe('2026-11-03');expect(kstDay(new Date(minute(actual)+60000))).toBe('2026-11-02');
  expect(kstDay(checkoutIncidentPlannedCheckoutAt(actual,'manual'))).toBe('2026-11-02');
 });
 it('preserves every valid minute in the existing more-than-two-minute window',()=>{
  for(let m=0;m<1438;m++){
   const actual=new Date(Date.parse('2026-11-02T15:00:00Z')+m*60000+59000);const planned=checkoutIncidentPlannedCheckoutAt(actual,'manual');
   expect(kstDay(planned)).toBe(kstDay(actual));expect(minute(planned)).toBeGreaterThan(minute(actual));
   expect(kstDay(new Date(minute(actual)+60000))).toBe(kstDay(actual));
  }
 });
 it.each(['2026-11-02T14:51:20Z','2026-11-02T14:59:30Z'])('leaves scheduled geometry unchanged at %s',iso=>{
  const actual=new Date(iso);expect(checkoutIncidentPlannedCheckoutAt(actual,'scheduled').getTime()).toBe(actual.getTime());
 });
 it('fails closed if a host pause has carried manual setup outside the safe day window',()=>{
  expect(()=>checkoutIncidentPlannedCheckoutAt(new Date('2026-11-02T14:59:30Z'),'manual')).toThrow('CHECKOUT_INCIDENT_FIXTURE_DATE_BOUNDARY');
 });
 it('rejects invalid fixture clocks and modes',()=>{
  expect(()=>checkoutIncidentPlannedCheckoutAt(new Date('invalid'),'manual')).toThrow('CHECKOUT_INCIDENT_FIXTURE_CLOCK_INVALID');
  expect(()=>checkoutIncidentPlannedCheckoutAt(new Date('2026-11-02T14:51:20Z'),'unknown')).toThrow('CHECKOUT_INCIDENT_FIXTURE_MODE_INVALID');
 });
});
