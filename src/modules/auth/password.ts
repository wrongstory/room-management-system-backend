const temporaryPasswordPattern = /^\d{4}$/;

export function toSupabaseAuthPassword(password: string): string {
  return temporaryPasswordPattern.test(password) ? `tmp:${password}` : password;
}
