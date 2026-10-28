const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('node:module');
const jwt = require('jsonwebtoken');
const {
  parseIntegerSetting,
  validateJwtSecret,
} = require('../config/validation');

const STRONG_SECRET = 'M7vQ!2zL#9pR4xT@6cW8nK$3bH5sY1dF';
const previousNodeEnv = process.env.NODE_ENV;
const previousJwtSecret = process.env.JWT_SECRET;
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = STRONG_SECRET;
const { createConfig } = require('../config/config');
if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
else process.env.NODE_ENV = previousNodeEnv;
if (previousJwtSecret === undefined) delete process.env.JWT_SECRET;
else process.env.JWT_SECRET = previousJwtSecret;

function baseEnvironment(overrides = {}) {
  return {
    NODE_ENV: 'test',
    JWT_SECRET: STRONG_SECRET,
    ...overrides,
  };
}

test('requires a JWT secret in production and rejects missing or blank values', () => {
  assert.throws(
    () => validateJwtSecret(undefined, 'production'),
    /JWT_SECRET is required/
  );
  assert.throws(
    () => validateJwtSecret('   ', 'production'),
    /JWT_SECRET is required/
  );
});

test('rejects weak and placeholder JWT secrets without echoing their value', () => {
  for (const secret of [
    'fallback-secret-key',
    'your-super-secret-jwt-key-here',
    'change-me-now-please-1234567890',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'short',
  ]) {
    assert.throws(
      () => validateJwtSecret(secret, 'production'),
      (error) => {
        assert.match(error.message, /JWT_SECRET/);
        assert.equal(error.message.includes(secret), false);
        return true;
      }
    );
    assert.throws(() => validateJwtSecret(secret, 'development'), /JWT_SECRET/);
  }
});

test('accepts a sufficiently strong unique secret in production and development', () => {
  assert.equal(validateJwtSecret(STRONG_SECRET, 'production'), STRONG_SECRET);
  assert.equal(validateJwtSecret(STRONG_SECRET, 'development'), STRONG_SECRET);
});

test('uses a random ephemeral secret only when development JWT_SECRET is absent', () => {
  const first = validateJwtSecret(undefined, 'development');
  const second = validateJwtSecret(undefined, 'development');
  assert.ok(first.length >= 32);
  assert.notEqual(first, second);
});

test('parses only exact bounded decimal integers', () => {
  assert.equal(
    parseIntegerSetting({ VALUE: '12' }, 'VALUE', 5, { min: 1, max: 20 }),
    12
  );
  assert.equal(parseIntegerSetting({}, 'VALUE', 5, { min: 1, max: 20 }), 5);
  for (const value of ['0', '-1', 'NaN', '1.5', '12abc', '+2', '999']) {
    assert.throws(
      () =>
        parseIntegerSetting({ VALUE: value }, 'VALUE', 5, { min: 1, max: 20 }),
      (error) => {
        assert.match(error.message, /VALUE/);
        assert.equal(error.message.includes('12abc'), false);
        return true;
      }
    );
  }
});

test('validates concurrency, per-user limits, lease, and crawl budgets at config startup', () => {
  const valid = createConfig(
    baseEnvironment({
      MAX_CONCURRENT_CRAWLS: '5',
      MAX_ACTIVE_CRAWL_JOBS_PER_USER: '10',
      MAX_CONCURRENT_CRAWLS_PER_USER: '2',
      USER_CRAWL_EXECUTION_LEASE_MS: '120000',
      MAX_PAGES_PER_CRAWL: '100',
      MAX_NETWORK_REQUESTS_PER_CRAWL: '1000',
    })
  );
  assert.equal(valid.crawler.maxConcurrent, 5);
  assert.equal(valid.crawler.maxActiveJobsPerUser, 10);
  assert.equal(valid.crawler.maxConcurrentPerUser, 2);
  assert.equal(valid.crawler.userExecutionLeaseMs, 120000);
  assert.equal(valid.crawler.maxPagesPerCrawl, 100);
  assert.equal(valid.crawler.maxNetworkRequestsPerCrawl, 1000);

  const invalidVariables = [
    'MAX_CONCURRENT_CRAWLS',
    'MAX_ACTIVE_CRAWL_JOBS_PER_USER',
    'MAX_CONCURRENT_CRAWLS_PER_USER',
    'USER_CRAWL_EXECUTION_LEASE_MS',
    'MAX_PAGES_PER_CRAWL',
    'MAX_NETWORK_REQUESTS_PER_CRAWL',
  ];
  for (const name of invalidVariables) {
    for (const value of ['0', '-2', 'NaN', '1.2', '5x']) {
      assert.throws(
        () => createConfig(baseEnvironment({ [name]: value })),
        new RegExp(name)
      );
    }
  }
});

test('retains existing sample crawler defaults when numeric settings are unset', () => {
  const config = createConfig(baseEnvironment());
  assert.equal(config.crawler.maxConcurrent, 10);
  assert.equal(config.crawler.maxActiveJobsPerUser, 10);
  assert.equal(config.crawler.maxConcurrentPerUser, 2);
  assert.equal(config.crawler.userExecutionLeaseMs, 120000);
  assert.equal(config.crawler.maxPagesPerCrawl, 100);
  assert.equal(config.crawler.maxNetworkRequestsPerCrawl, 1000);
});

test('requires explicit PostgreSQL and Redis endpoints in production', () => {
  assert.throws(
    () =>
      createConfig({
        NODE_ENV: 'production',
        JWT_SECRET: STRONG_SECRET,
        REDIS_HOST: 'redis.prod',
      }),
    /DATABASE_URL is required/
  );
  assert.throws(
    () =>
      createConfig({
        NODE_ENV: 'production',
        JWT_SECRET: STRONG_SECRET,
        DATABASE_URL: 'postgresql://db/app',
      }),
    /REDIS_HOST is required/
  );
  const development = createConfig({
    NODE_ENV: 'development',
    JWT_SECRET: STRONG_SECRET,
  });
  assert.equal(development.database.name, 'deadlink_watchdog_dev');
  assert.equal(development.redis.host, 'localhost');
});

test('access and refresh tokens cannot be used interchangeably', () => {
  const authPath = require.resolve('../src/middleware/auth');
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (parent?.filename === authPath && request === '../lib/prisma') {
      return {};
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  let auth;
  try {
    auth = require(authPath);
  } finally {
    Module._load = originalLoad;
    delete require.cache[authPath];
  }

  const tokens = auth.generateTokens({
    id: 'auth-token-test-user',
    email: 'auth-token-test@example.invalid',
    role: 'user',
  });
  assert.equal(auth.verifyAccessToken(tokens.accessToken).tokenUse, 'access');
  assert.equal(
    auth.verifyRefreshToken(tokens.refreshToken).tokenUse,
    'refresh'
  );
  assert.throws(
    () => auth.verifyRefreshToken(tokens.accessToken),
    /Invalid refresh token/
  );
  assert.throws(
    () => auth.verifyAccessToken(tokens.refreshToken),
    jwt.JsonWebTokenError
  );
});
