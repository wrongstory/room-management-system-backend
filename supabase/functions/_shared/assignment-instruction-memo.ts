// Generated from src/modules/assignments/instruction-memo.ts. DO NOT EDIT.
/** A room's work instructions belong to one assignment revision, never the room. */
export const ASSIGNMENT_INSTRUCTION_MEMO_MAX = 500;

// Deliberately narrow recognizers, also enforced by SQL. This is not a claim
// that arbitrary names or every possible form of personal data can be detected.
const privateContentPatterns = [
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
  /https?:\/\/|www\./i,
  /(^|[^0-9])(01[016789]|\+82[ -]?1[016789])[ -]?[0-9]{3,4}[ -]?[0-9]{4}([^0-9]|$)/,
  /(?:PIN|비밀번호|출입코드)(?:[ \t\r\n]*[:=][ \t\r\n]*|[ \t\r\n]+)[0-9]{4,}/i,
];

export class InstructionMemoValidationError extends Error {
  constructor() {
    super("Invalid assignment instruction memo");
    this.name = "InstructionMemoValidationError";
  }
}

/** Reject values PostgreSQL text cannot preserve without reflecting their content. */
function validText(value: string): boolean {
  if (value.includes("\u0000")) return false;
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

/** Call only for an explicitly present field; omission means inherit, not clear. */
export function normalizeInstructionMemo(value: unknown): string | null {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    value.length > ASSIGNMENT_INSTRUCTION_MEMO_MAX ||
    !validText(value)
  ) {
    throw new InstructionMemoValidationError();
  }
  const normalized = value.trim();
  if (
    normalized.length > ASSIGNMENT_INSTRUCTION_MEMO_MAX ||
    privateContentPatterns.some((pattern) => pattern.test(normalized))
  ) {
    throw new InstructionMemoValidationError();
  }
  return normalized || null;
}

/** Legacy receipts stay empty; never substitute a newer assignment's instructions. */
export function parseInstructionMemoRead(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const memo = normalizeInstructionMemo(value);
  if (memo === null || memo !== value) {
    throw new InstructionMemoValidationError();
  }
  return memo;
}
