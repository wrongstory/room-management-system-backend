import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  InstructionMemoValidationError,
  normalizeInstructionMemo,
  parseInstructionMemoRead,
} from '../src/modules/assignments/instruction-memo.js';

describe('assignment instruction revision contract', () => {
  it.each([
    [' 142호 수건 5개\n물캡슐 2개 ', '142호 수건 5개\n물캡슐 2개'],
    ['\uFEFF\u00a0쓰레기만 치워주세요\u3000', '쓰레기만 치워주세요'],
    ['2026-10-30 14:30까지 도어락 주변만 닦아주세요', '2026-10-30 14:30까지 도어락 주변만 닦아주세요'],
    ['물 010개', '물 010개'],
    ['😀'.repeat(250), '😀'.repeat(250)],
    ['가'.repeat(500), '가'.repeat(500)],
    ['', null],
    ['\t\n\r \u2028', null],
    [null, null],
  ])('normalizes valid work text without banning quantities (%#)', (value, expected) => {
    expect(normalizeInstructionMemo(value)).toBe(expected);
  });

  it.each([
    undefined, 3, true, {}, [], '가'.repeat(501), ' '.repeat(501),
    ` ${'가'.repeat(500)}`, '😀'.repeat(251), '\u0000', '\ud800', '\udfff',
    '가\ud800나', '010-1234-5678로 연락', '01012345678', '+82 10 1234 5678',
    'person@example.invalid', 'HTTPS://example.invalid/a', 'www.example.invalid',
    'PIN:1234', 'pin = 123456', '비밀번호 1234', '출입코드\n123456',
  ])('rejects invalid or explicitly sensitive input without reflecting it (%#)', (value) => {
    expect(() => normalizeInstructionMemo(value)).toThrow(InstructionMemoValidationError);
    expect(() => normalizeInstructionMemo(value)).toThrow('Invalid assignment instruction memo');
  });

  it('maps historical missing keys to null, with no invented current revision', () => {
    expect(parseInstructionMemoRead(undefined)).toBeNull();
    expect(parseInstructionMemoRead(null)).toBeNull();
    expect(parseInstructionMemoRead('수건 5개')).toBe('수건 5개');
    expect(() => parseInstructionMemoRead(' 수건 5개')).toThrow();
    expect(() => parseInstructionMemoRead('')).toThrow();
  });

  it('shares the exact pure validator with the deployed Edge path', () => {
    const source = readFileSync('src/modules/assignments/instruction-memo.ts', 'utf8').replaceAll('\r\n', '\n');
    const generated = readFileSync('supabase/functions/_shared/assignment-instruction-memo.ts', 'utf8').replaceAll('\r\n', '\n');
    expect(generated).toBe(`// Generated from src/modules/assignments/instruction-memo.ts. DO NOT EDIT.\n${source}`);
  });
});
