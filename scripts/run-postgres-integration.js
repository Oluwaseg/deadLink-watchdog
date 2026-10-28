const { execFileSync } = require('node:child_process');
const { Client } = require('pg');
require('dotenv').config();

function parseDatabaseTarget(connectionString) {
  try {
    const url = new URL(connectionString);
    return {
      host: url.hostname,
      port: Number(url.port || 5432),
      database: decodeURIComponent(url.pathname.slice(1).split('?')[0]),
    };
  } catch {
    throw new Error('TEST_DATABASE_URL must be a valid PostgreSQL URL.');
  }
}

function assertDedicatedTestDatabase(testTarget, normalTargets) {
  if (!['localhost', '127.0.0.1', '::1'].includes(testTarget.host)) {
    throw new Error(
      'Refusing PostgreSQL integration setup: this runner only permits a locally installed PostgreSQL service.'
    );
  }
  if (
    !/(^|[_-])(test|testing|integration|it)([_-]|$)/i.test(testTarget.database)
  ) {
    throw new Error(
      'Refusing PostgreSQL integration setup: target database name must clearly identify a dedicated test database.'
    );
  }
  if (
    normalTargets.some(
      (target) =>
        target &&
        target.host === testTarget.host &&
        target.port === testTarget.port &&
        target.database === testTarget.database
    )
  ) {
    throw new Error(
      'Refusing PostgreSQL integration setup: test database matches a configured application database.'
    );
  }
}

async function main() {
  if (!process.env.TEST_DATABASE_URL) {
    throw new Error(
      'TEST_DATABASE_URL is required. Create a dedicated local test database and configure its URL; no database was changed.'
    );
  }

  const testTarget = parseDatabaseTarget(process.env.TEST_DATABASE_URL);
  const normalTargets = [
    process.env.DATABASE_URL ||
      `postgresql://${process.env.DB_USER || 'postgres'}:${process.env.DB_PASSWORD || 'password'}@${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || 5432}/${process.env.DB_NAME || 'deadlink_watchdog_dev'}`,
  ]
    .filter(Boolean)
    .map(parseDatabaseTarget);
  assertDedicatedTestDatabase(testTarget, normalTargets);

  const client = new Client({
    connectionString: process.env.TEST_DATABASE_URL,
    connectionTimeoutMillis: 3000,
  });
  await client.connect();
  try {
    const { rows } = await client.query(
      'SELECT current_database() AS database, current_user AS role'
    );
    if (rows[0].database !== testTarget.database) {
      throw new Error(
        'Refusing PostgreSQL integration setup: connected database does not match TEST_DATABASE_URL.'
      );
    }
    console.log(
      `Verified dedicated PostgreSQL test target: ${testTarget.host}:${testTarget.port}/${rows[0].database} (role ${rows[0].role}).`
    );
  } finally {
    await client.end();
  }

  const testEnv = {
    ...process.env,
    DATABASE_URL: process.env.TEST_DATABASE_URL,
    NODE_ENV: 'test',
    JWT_SECRET: 'M7vQ!2zL#9pR4xT@6cW8nK$3bH5sY1dF',
    BULL_PREFIX: `postgres-it-${process.pid}`,
  };
  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    cwd: process.cwd(),
    env: testEnv,
    stdio: 'inherit',
  });
  execFileSync(
    process.execPath,
    ['--test', 'tests/postgres-crawl-result.integration.test.js'],
    { cwd: process.cwd(), env: testEnv, stdio: 'inherit' }
  );
}

main().catch((error) => {
  console.error(`PostgreSQL integration setup failed: ${error.message}`);
  process.exitCode = 1;
});
