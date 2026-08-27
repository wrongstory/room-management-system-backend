const sensitiveLogPaths = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers.set-cookie',
  '*.authorization',
  '*.cookie',
  '*.password',
  '*.currentPassword',
  '*.newPassword',
  '*.temporaryPassword',
  '*.accessToken',
  '*.refreshToken',
  '*.pin',
  '*.guestName',
  '*.guest_name_encrypted',
  '*.phone',
  '*.phoneLookupHash',
  '*.phone_lookup_hash',
  '*.googleDriveRefreshToken',
  '*.GOOGLE_DRIVE_REFRESH_TOKEN',
  '*.SUPABASE_SECRET_KEY',
  '*.RESERVATION_PII_KEY_BASE64'
] as const;

export function loggerOptions(level: string) {
  return {
    level,
    redact: {
      paths: [...sensitiveLogPaths],
      censor: '[REDACTED]'
    }
  };
}
