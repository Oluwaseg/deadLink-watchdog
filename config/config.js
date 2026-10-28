require('dotenv').config();

const { parseIntegerSetting, validateJwtSecret } = require('./validation');

function createConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || 'development';
  if (nodeEnv === 'production' && !env.DATABASE_URL?.trim()) {
    throw new Error('DATABASE_URL is required when NODE_ENV=production.');
  }
  if (nodeEnv === 'production' && !env.REDIS_HOST?.trim()) {
    throw new Error('REDIS_HOST is required when NODE_ENV=production.');
  }
  const integer = (name, fallback, min, max = Number.MAX_SAFE_INTEGER) =>
    parseIntegerSetting(env, name, fallback, { min, max });

  return {
    // Server Configuration
    port: integer('PORT', 3000, 1, 65535),
    nodeEnv,

    // Database Configuration (Prisma uses DATABASE_URL)
    database: {
      url:
        env.DATABASE_URL ||
        `postgresql://${env.DB_USER || 'postgres'}:${env.DB_PASSWORD || 'password'}@${env.DB_HOST || 'localhost'}:${integer('DB_PORT', 5432, 1, 65535)}/${env.DB_NAME || 'deadlink_watchdog_dev'}?schema=public`,
      host: env.DB_HOST || 'localhost',
      port: integer('DB_PORT', 5432, 1, 65535),
      name: env.DB_NAME || 'deadlink_watchdog_dev',
      user: env.DB_USER || 'postgres',
      password: env.DB_PASSWORD || 'password',
    },

    // Redis Configuration
    redis: {
      host: env.REDIS_HOST || 'localhost',
      port: integer('REDIS_PORT', 6379, 1, 65535),
      password: env.REDIS_PASSWORD || null,
      prefix: env.BULL_PREFIX || undefined,
    },

    // JWT Configuration
    jwt: {
      secret: validateJwtSecret(env.JWT_SECRET, nodeEnv),
      expiresIn: env.JWT_EXPIRES_IN || '7d',
    },

    // Email Configuration
    email: {
      host: env.EMAIL_HOST || 'smtp.gmail.com',
      port: integer('EMAIL_PORT', 587, 1, 65535),
      user: env.EMAIL_USER,
      password: env.EMAIL_PASSWORD,
      from: env.EMAIL_FROM || 'noreply@deadlinkwatchdog.com',
      fromName: env.EMAIL_FROM_NAME || 'DeadLink Watchdog',
    },

    // Crawler Configuration
    crawler: {
      executablePath: env.PUPPETEER_EXECUTABLE_PATH || undefined,
      delay: integer('CRAWLER_DELAY', 200, 0),
      timeout: integer('CRAWLER_TIMEOUT', 10000, 1),
      userAgent: env.CRAWLER_USER_AGENT || 'DeadLinkWatchdog/1.0',
      maxConcurrent: integer('MAX_CONCURRENT_CRAWLS', 10, 1),
      maxActiveJobsPerUser: integer('MAX_ACTIVE_CRAWL_JOBS_PER_USER', 10, 1),
      maxConcurrentPerUser: integer('MAX_CONCURRENT_CRAWLS_PER_USER', 2, 1),
      userExecutionLeaseMs: integer(
        'USER_CRAWL_EXECUTION_LEASE_MS',
        120000,
        60000
      ),
      maxRetries: integer('CRAWLER_MAX_RETRIES', 2, 0),
      retryDelay: integer('CRAWLER_RETRY_DELAY', 500, 0),
      circuitBreakerTimeout: integer('CIRCUIT_BREAKER_TIMEOUT', 30000, 1),
      circuitBreakerThreshold: integer('CIRCUIT_BREAKER_THRESHOLD', 3, 1),
      cacheTimeout: integer('CRAWLER_CACHE_TIMEOUT', 300000, 0),
      rateLimitPerDomain: integer('RATE_LIMIT_PER_DOMAIN', 5, 1),
      maxLinksPerSite: integer('MAX_LINKS_PER_SITE', 100, 1),
      maxPagesPerCrawl: integer('MAX_PAGES_PER_CRAWL', 100, 1),
      maxNetworkRequestsPerCrawl: integer(
        'MAX_NETWORK_REQUESTS_PER_CRAWL',
        1000,
        1
      ),
      fastMode: env.CRAWLER_FAST_MODE === 'true',
    },

    // Rate Limiting
    rateLimit: {
      windowMs: integer('RATE_LIMIT_WINDOW_MS', 900000, 1),
      maxRequests: integer('RATE_LIMIT_MAX_REQUESTS', 100, 1),
    },

    // Notification Settings
    notifications: {
      webhookTimeout: integer('WEBHOOK_TIMEOUT', 5000, 1),
    },
  };
}

module.exports = createConfig();
module.exports.createConfig = createConfig;
