const { randomUUID } = require('node:crypto');
const { createClient } = require('redis');
require('dotenv').config();

function parseRedisTarget(connectionString) {
  try {
    const url = new URL(connectionString);
    if (!['redis:', 'rediss:'].includes(url.protocol)) throw new Error();
    return {
      host: url.hostname,
      port: Number(url.port || (url.protocol === 'rediss:' ? 6380 : 6379)),
      password: url.password ? decodeURIComponent(url.password) : undefined,
    };
  } catch {
    throw new Error(
      'TEST_REDIS_URL must be a valid redis:// or rediss:// URL.'
    );
  }
}

async function main() {
  const configuredUrl = process.env.TEST_REDIS_URL || process.env.REDIS_URL;
  const target = configuredUrl
    ? parseRedisTarget(configuredUrl)
    : {
        host: process.env.REDIS_HOST || 'localhost',
        port: Number(process.env.REDIS_PORT || 6379),
        password: process.env.REDIS_PASSWORD || undefined,
      };
  const probe = createClient({
    socket: {
      host: target.host,
      port: target.port,
      tls: Boolean(configuredUrl?.startsWith('rediss:')),
      connectTimeout: 3000,
    },
    password: target.password,
  });
  probe.on('error', () => {});
  await probe.connect();
  const pong = await probe.ping();
  await probe.quit();
  if (pong !== 'PONG') throw new Error('Local Redis did not return PONG.');

  const testEnv = {
    ...process.env,
    REDIS_URL: '',
    REDIS_HOST: target.host,
    REDIS_PORT: String(target.port),
    REDIS_PASSWORD: target.password || '',
    BULL_PREFIX: `deadlink-it-${randomUUID()}`,
    MAX_ACTIVE_CRAWL_JOBS_PER_USER: '2',
    MAX_CONCURRENT_CRAWLS_PER_USER: '1',
    NODE_ENV: 'test',
    JWT_SECRET: 'M7vQ!2zL#9pR4xT@6cW8nK$3bH5sY1dF',
  };
  console.log(
    `Verified local Redis test endpoint: ${target.host}:${target.port} (PONG; isolated Bull prefix).`
  );
  const { spawnSync } = require('node:child_process');
  const result = spawnSync(
    process.execPath,
    ['tests/redis-bull.integration.test.js'],
    { cwd: process.cwd(), env: testEnv, stdio: 'inherit' }
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status || 1;
}

main().catch((error) => {
  console.error(`Redis integration setup failed: ${error.message}`);
  process.exitCode = 1;
});
