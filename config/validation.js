const { randomBytes } = require('node:crypto');

const KNOWN_JWT_PLACEHOLDERS = new Set([
  'fallback-secret-key',
  'your-super-secret-jwt-key-here',
  'your-secret-key',
  'your_jwt_secret',
  'jwt_secret',
  'change-me',
  'changeme',
  'replace-me',
  'secret',
  'password',
  'test',
]);

function validateJwtSecret(value, nodeEnv = 'development') {
  const secret = typeof value === 'string' ? value.trim() : '';
  const isProduction = String(nodeEnv).toLowerCase() === 'production';

  if (!secret) {
    if (isProduction) {
      throw new Error('JWT_SECRET is required when NODE_ENV=production.');
    }
    return randomBytes(48).toString('base64url');
  }

  const normalized = secret.toLowerCase();
  const characterClasses = [
    /[a-z]/.test(secret),
    /[A-Z]/.test(secret),
    /[0-9]/.test(secret),
    /[^a-zA-Z0-9]/.test(secret),
  ].filter(Boolean).length;
  const distinctCharacters = new Set(secret).size;
  const placeholderMatch =
    KNOWN_JWT_PLACEHOLDERS.has(normalized) ||
    /^(your|change|replace|example|default|fallback)[-_ ]/.test(normalized);

  if (
    placeholderMatch ||
    secret.length < 32 ||
    characterClasses < 3 ||
    distinctCharacters < 16
  ) {
    throw new Error(
      'JWT_SECRET must be a non-placeholder secret with at least 32 characters and sufficient character diversity.'
    );
  }

  return secret;
}

function parseIntegerSetting(env, name, defaultValue, { min, max }) {
  const raw = env[name];
  if (raw === undefined || raw === null || raw === '') return defaultValue;
  const value = String(raw).trim();
  if (!/^\d+$/.test(value)) {
    throw new Error(
      `${name} must be a base-10 integer between ${min} and ${max}.`
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(
      `${name} must be a base-10 integer between ${min} and ${max}.`
    );
  }
  return parsed;
}

module.exports = {
  parseIntegerSetting,
  validateJwtSecret,
};
