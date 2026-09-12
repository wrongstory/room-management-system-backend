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
  '*.GOOGLE_DRIVE_CLIENT_SECRET',
  '*.GOOGLE_DRIVE_ROOT_FOLDER_ID',
  '*.SUPABASE_SECRET_KEY',
  '*.RESERVATION_PII_KEY_BASE64',
  '*.RESERVATION_PII_KEYRING_JSON',
  '*.RESERVATION_GUEST_NAME_PEPPER',
  '*.PAYROLL_CURSOR_HMAC_SECRET',
  '*.NOTIFICATION_CURSOR_HMAC_SECRET',
  '*.endpoint','*.p256dh','*.auth','*.ciphertext','*.ciphertextBase64','*.nonce','*.nonceBase64','*.authTag','*.authTagBase64',
  '*.endpointDigest','*.sessionDigest','*.materialDigest','*.WEB_PUSH_SUBSCRIPTION_KEY_BASE64',
  '*.WEB_PUSH_SUBSCRIPTION_KEYRING_JSON','*.WEB_PUSH_BINDING_DIGEST_SECRET',
  '*.VAPID_PRIVATE_KEY','*.VAPID_KEYRING_JSON','*.NOTIFICATION_DELIVERY_INVOKE_SECRET'
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
