const temporaryPasswordPattern = /^\d{4}$/;
const numericPersonalPasswordPattern = /^\d{6,72}$/;
const strongPersonalPasswordPattern = /^(?=.{10,72}$)(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9])[\x20-\x7e]+$/;

export function isPersonalPassword(password: string): boolean {
  return numericPersonalPasswordPattern.test(password) || strongPersonalPasswordPattern.test(password);
}

export function isLoginPassword(password: string): boolean {
  return temporaryPasswordPattern.test(password) || isPersonalPassword(password);
}

export function toSupabaseAuthPassword(password: string): string {
  return temporaryPasswordPattern.test(password) ? `tmp:${password}` : password;
}
