require('dotenv').config();

module.exports = {
  // Server Configuration
  port: process.env.PORT || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',

  // Database Configuration
  database: {
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    name: process.env.DB_NAME || 'deadlink_watchdog',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'password',
  },

  // Redis Configuration
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: process.env.REDIS_PORT || 6379,
    password: process.env.REDIS_PASSWORD || null,
  },

  // JWT Configuration
  jwt: {
    secret: process.env.JWT_SECRET || 'fallback-secret-key',
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  },

  // Email Configuration
  email: {
    host: process.env.EMAIL_HOST || 'smtp.gmail.com',
    port: process.env.EMAIL_PORT || 587,
    user: process.env.EMAIL_USER,
    password: process.env.EMAIL_PASSWORD,
    from: process.env.EMAIL_FROM || 'noreply@deadlinkwatchdog.com',
    fromName: process.env.EMAIL_FROM_NAME || 'DeadLink Watchdog',
  },

  // Crawler Configuration
  crawler: {
    delay: parseInt(process.env.CRAWLER_DELAY) || 200, // Reduced from 1000ms
    timeout: parseInt(process.env.CRAWLER_TIMEOUT) || 10000, // Reduced from 30000ms
    userAgent: process.env.CRAWLER_USER_AGENT || 'DeadLinkWatchdog/1.0',
    maxConcurrent: parseInt(process.env.MAX_CONCURRENT_CRAWLS) || 10, // Increased from 5
    maxRetries: parseInt(process.env.CRAWLER_MAX_RETRIES) || 2, // Reduced from 3
    retryDelay: parseInt(process.env.CRAWLER_RETRY_DELAY) || 500, // Reduced from 1000ms
    circuitBreakerTimeout:
      parseInt(process.env.CIRCUIT_BREAKER_TIMEOUT) || 30000, // Reduced from 60000ms
    circuitBreakerThreshold:
      parseInt(process.env.CIRCUIT_BREAKER_THRESHOLD) || 3, // Reduced from 5
    cacheTimeout: parseInt(process.env.CRAWLER_CACHE_TIMEOUT) || 300000, // 5 minutes
    rateLimitPerDomain: parseInt(process.env.RATE_LIMIT_PER_DOMAIN) || 5, // Increased from 2
    maxLinksPerSite: parseInt(process.env.MAX_LINKS_PER_SITE) || 100, // Limit links per site
    fastMode: process.env.CRAWLER_FAST_MODE === 'true' || false, // Fast mode for bulk crawling
  },

  // Rate Limiting
  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 900000, // 15 minutes
    maxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
  },

  // Notification Settings
  notifications: {
    webhookTimeout: parseInt(process.env.WEBHOOK_TIMEOUT) || 5000,
  },
};
