const Bull = require('bull');
const { randomUUID } = require('crypto');
const config = require('../../config/config');
const {
  CrawlCancellationError,
  abortableDelay,
  throwIfAborted,
} = require('./crawlCancellation');

const ADMISSION_LOCK_TTL_MS = 60000;
const ADMISSION_LOCK_WAIT_MS = 10000;
const ADMISSION_LOCK_RENEW_MS = 15000;
const EXECUTION_LOCK_RENEW_MS = 30000;
const ACTIVE_CRAWL_STATES = ['waiting', 'active', 'delayed', 'paused'];
const CRAWL_CANCEL_KEY_TTL_MS = 10 * 60 * 1000;
let queueEventListenersRegistered = false;

const RELEASE_LOCK_SCRIPT = `
  if redis.call('get', KEYS[1]) == ARGV[1] then
    return redis.call('del', KEYS[1])
  end
  return 0
`;

const EXTEND_LOCK_SCRIPT = `
  if redis.call('get', KEYS[1]) == ARGV[1] then
    return redis.call('pexpire', KEYS[1], ARGV[2])
  end
  return 0
`;

class QueueAdmissionError extends Error {
  constructor(message, statusCode, code) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

const wait = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

// Create Redis connection options
const redisConfig = {
  host: config.redis.host,
  port: config.redis.port,
  password: config.redis.password || undefined,
  maxRetriesPerRequest: 3,
  retryDelayOnFailover: 100,
  enableReadyCheck: false,
  maxRetriesPerRequest: null,
  lazyConnect: true,
};

// Create job queues
const crawlQueue = new Bull('crawl queue', {
  redis: redisConfig,
  ...(config.redis.prefix ? { prefix: config.redis.prefix } : {}),
  defaultJobOptions: {
    removeOnComplete: 50, // Keep last 50 completed jobs
    removeOnFail: 100, // Keep last 100 failed jobs
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000,
    },
  },
});

const notificationQueue = new Bull('notification queue', {
  redis: redisConfig,
  ...(config.redis.prefix ? { prefix: config.redis.prefix } : {}),
  defaultJobOptions: {
    removeOnComplete: 20,
    removeOnFail: 50,
    attempts: 2,
    backoff: {
      type: 'fixed',
      delay: 5000,
    },
  },
});

class QueueService {
  constructor() {
    this.crawlQueue = crawlQueue;
    this.notificationQueue = notificationQueue;
    this.setupEventListeners();
  }

  setupEventListeners() {
    if (queueEventListenersRegistered) return;
    queueEventListenersRegistered = true;

    // Crawl queue events
    this.crawlQueue.on('completed', (job, result) => {
      console.log(
        `Crawl job ${job.id} completed for website ${job.data.websiteId}`
      );
    });

    this.crawlQueue.on('failed', (job, err) => {
      console.error(`Crawl job ${job.id} failed:`, err.message);
    });

    this.crawlQueue.on('stalled', (job) => {
      console.warn(`Crawl job ${job.id} stalled`);
    });

    // Notification queue events
    this.notificationQueue.on('completed', (job, result) => {
      console.log(`Notification job ${job.id} completed`);
    });

    this.notificationQueue.on('failed', (job, err) => {
      console.error(`Notification job ${job.id} failed:`, err.message);
    });
  }

  // Add a crawl job to the queue
  async addCrawlJob(websiteId, userId, options = {}) {
    const jobData = {
      websiteId,
      userId,
      crawlDepth: options.crawlDepth || 1,
      priority: options.priority || 'normal',
      scheduledBy: options.scheduledBy || 'manual',
      crawlResultId: options.crawlResultId || null,
    };

    const jobOptions = {
      priority: this.getPriorityValue(options.priority),
      delay: options.delay || 0,
      jobId: options.jobId || `crawl-${websiteId}-${randomUUID()}`,
    };

    try {
      const job = await this.withCrawlAdmissionLock(async (assertLockOwned) => {
        const pendingJobs = await this.crawlQueue.getJobs(
          ACTIVE_CRAWL_STATES,
          0,
          -1
        );
        const pendingCrawls = pendingJobs.filter(
          (pendingJob) => pendingJob.name === 'crawl-website'
        );

        if (
          pendingCrawls.some(
            (pendingJob) => pendingJob.data.websiteId === websiteId
          )
        ) {
          throw new QueueAdmissionError(
            'A crawl is already queued or running for this website.',
            409,
            'CRAWL_ALREADY_ACTIVE'
          );
        }

        const userPendingCount = pendingCrawls.filter(
          (pendingJob) => pendingJob.data.userId === userId
        ).length;
        if (userPendingCount >= config.crawler.maxActiveJobsPerUser) {
          throw new QueueAdmissionError(
            `You have reached the limit of ${config.crawler.maxActiveJobsPerUser} active crawl jobs. Wait for a crawl to finish before starting another.`,
            429,
            'CRAWL_ACTIVE_LIMIT_REACHED'
          );
        }

        await assertLockOwned();
        return this.crawlQueue.add('crawl-website', jobData, jobOptions);
      });
      console.log(`✅ Added crawl job ${job.id} for website ${websiteId}`);

      // Log queue stats after adding job
      setTimeout(async () => {
        const waiting = await this.crawlQueue.getWaiting();
        const active = await this.crawlQueue.getActive();
        console.log(
          `📊 After adding job - Waiting: ${waiting.length}, Active: ${active.length}`
        );
      }, 100);

      return job;
    } catch (error) {
      if (!(error instanceof QueueAdmissionError)) {
        console.error('Failed to add crawl job:', error);
      }
      throw error;
    }
  }

  async withCrawlAdmissionLock(callback) {
    const client = this.crawlQueue.client;
    const lockKey = this.crawlQueue.toKey('crawl-admission-lock');
    const lockToken = randomUUID();
    const deadline = Date.now() + ADMISSION_LOCK_WAIT_MS;
    let acquired = false;
    let lockLost = false;
    let renewTimer;

    while (!acquired && Date.now() < deadline) {
      acquired =
        (await client.set(
          lockKey,
          lockToken,
          'PX',
          ADMISSION_LOCK_TTL_MS,
          'NX'
        )) === 'OK';
      if (!acquired) await wait(25);
    }

    if (!acquired) {
      throw new QueueAdmissionError(
        'Crawl queue admission is busy. Please try again.',
        503,
        'CRAWL_ADMISSION_BUSY'
      );
    }

    renewTimer = setInterval(async () => {
      try {
        const renewed = await client.eval(
          EXTEND_LOCK_SCRIPT,
          1,
          lockKey,
          lockToken,
          ADMISSION_LOCK_TTL_MS
        );
        if (Number(renewed) !== 1) lockLost = true;
      } catch {
        lockLost = true;
      }
    }, ADMISSION_LOCK_RENEW_MS);

    try {
      return await callback(async () => {
        if (lockLost) {
          throw new QueueAdmissionError(
            'Crawl queue admission could not be safely completed. Please retry.',
            503,
            'CRAWL_ADMISSION_BUSY'
          );
        }
        const renewed = await client.eval(
          EXTEND_LOCK_SCRIPT,
          1,
          lockKey,
          lockToken,
          ADMISSION_LOCK_TTL_MS
        );
        if (Number(renewed) !== 1) {
          throw new QueueAdmissionError(
            'Crawl queue admission could not be safely completed. Please retry.',
            503,
            'CRAWL_ADMISSION_BUSY'
          );
        }
      });
    } finally {
      clearInterval(renewTimer);
      await client.eval(RELEASE_LOCK_SCRIPT, 1, lockKey, lockToken);
    }
  }

  async acquireCrawlExecutionSlot(userId, signal = null, onLeaseLost = null) {
    const client = this.crawlQueue.client;
    const slotCount = config.crawler.maxConcurrentPerUser;
    const leaseMs = config.crawler.userExecutionLeaseMs;
    const ownerToken = randomUUID();
    let slotKey;

    while (!slotKey) {
      throwIfAborted(signal);
      for (let slot = 0; slot < slotCount; slot += 1) {
        throwIfAborted(signal);
        const candidateKey = this.crawlQueue.toKey(
          `crawl-user-slot:${userId}:${slot}`
        );
        const acquired = await client.set(
          candidateKey,
          ownerToken,
          'PX',
          leaseMs,
          'NX'
        );
        if (acquired === 'OK') {
          slotKey = candidateKey;
          break;
        }
      }
      if (!slotKey) await abortableDelay(250, signal);
    }

    let released = false;
    let leaseLost = false;
    let renewTimer;
    let renewalPromise = null;
    const markLeaseLost = (error) => {
      if (released || leaseLost) return;
      leaseLost = true;
      clearInterval(renewTimer);
      try {
        onLeaseLost?.(error);
      } catch (callbackError) {
        console.error(
          'Crawl execution lease-loss callback failed:',
          callbackError
        );
      }
    };
    const renew = async () => {
      if (released || leaseLost) return;
      try {
        const renewed = await client.eval(
          EXTEND_LOCK_SCRIPT,
          1,
          slotKey,
          ownerToken,
          leaseMs
        );
        if (released) return;
        if (Number(renewed) !== 1) {
          markLeaseLost(
            new Error(
              'Crawl execution lease is no longer owned by this worker.'
            )
          );
        }
      } catch (error) {
        markLeaseLost(error);
      }
    };

    renewTimer = setInterval(() => {
      if (renewalPromise || released || leaseLost) return;
      renewalPromise = renew().finally(() => {
        renewalPromise = null;
      });
    }, EXECUTION_LOCK_RENEW_MS);

    return {
      get leaseLost() {
        return leaseLost;
      },
      async release() {
        if (released) return;
        released = true;
        clearInterval(renewTimer);
        await renewalPromise?.catch(() => {});
        try {
          await client.eval(RELEASE_LOCK_SCRIPT, 1, slotKey, ownerToken);
        } catch (error) {
          console.error(
            'Failed to release per-user crawl execution slot:',
            error
          );
        }
      },
    };
  }

  async requestCrawlCancellation(jobId) {
    const cancelKey = this.crawlQueue.toKey(`crawl-cancel:${jobId}`);
    await this.crawlQueue.client.set(
      cancelKey,
      'cancelled',
      'PX',
      CRAWL_CANCEL_KEY_TTL_MS
    );
  }

  async watchCrawlCancellation(jobId, controller, intervalMs = 200) {
    const client = this.crawlQueue.client;
    const cancelKey = this.crawlQueue.toKey(`crawl-cancel:${jobId}`);
    let stopped = false;
    let checking = false;

    const check = async () => {
      if (stopped || checking || controller.signal.aborted) return;
      checking = true;
      try {
        const value = await client.get(cancelKey);
        if (value === 'cancelled') {
          controller.abort(new CrawlCancellationError('cancelled'));
        }
      } catch (error) {
        console.error('Failed to check crawl cancellation state:', error);
      } finally {
        checking = false;
      }
    };

    await check();
    const timer = setInterval(check, intervalMs);
    timer.unref?.();

    return async () => {
      stopped = true;
      clearInterval(timer);
    };
  }

  async clearCrawlCancellation(jobId) {
    const cancelKey = this.crawlQueue.toKey(`crawl-cancel:${jobId}`);
    try {
      await this.crawlQueue.client.del(cancelKey);
    } catch (error) {
      console.error('Failed to clear crawl cancellation key:', error);
    }
  }

  // Add a notification job to the queue
  async addNotificationJob(type, data, options = {}) {
    const jobData = {
      type, // 'email' or 'webhook'
      ...data,
    };

    const jobOptions = {
      delay: options.delay || 0,
      priority: this.getPriorityValue(options.priority || 'normal'),
    };

    try {
      const job = await this.notificationQueue.add(
        `send-${type}`,
        jobData,
        jobOptions
      );
      console.log(`Added notification job ${job.id} of type ${type}`);
      return job;
    } catch (error) {
      console.error('Failed to add notification job:', error);
      throw error;
    }
  }

  // Schedule recurring crawl jobs for all active websites
  async scheduleRecurringCrawls(websites) {
    const jobs = [];

    for (const website of websites) {
      if (!website.isActive) continue;

      const cronPattern = this.getCronPattern(website.crawlFrequency);
      const jobData = {
        websiteId: website.id,
        userId: website.userId,
        crawlDepth: 1,
        scheduledBy: 'cron',
      };

      try {
        // Remove existing recurring job if any
        await this.removeRecurringCrawlJob(website.id);

        // Add new recurring job
        const job = await this.crawlQueue.add('crawl-website', jobData, {
          repeat: { cron: cronPattern },
          jobId: `recurring-crawl-${website.id}`,
        });

        jobs.push(job);
        console.log(
          `Scheduled recurring crawl for website ${website.id} with pattern ${cronPattern}`
        );
      } catch (error) {
        console.error(
          `Failed to schedule recurring crawl for website ${website.id}:`,
          error
        );
      }
    }

    return jobs;
  }

  // Remove recurring crawl job for a website
  async removeRecurringCrawlJob(websiteId) {
    try {
      const jobId = `recurring-crawl-${websiteId}`;
      const repeatableJobs = await this.crawlQueue.getRepeatableJobs();

      for (const job of repeatableJobs) {
        if (job.id === jobId) {
          await this.crawlQueue.removeRepeatableByKey(job.key);
          console.log(`Removed recurring crawl job for website ${websiteId}`);
          break;
        }
      }
    } catch (error) {
      console.error(
        `Failed to remove recurring crawl job for website ${websiteId}:`,
        error
      );
    }
  }

  // Get queue statistics
  async getQueueStats() {
    const [crawlStats, notificationStats] = await Promise.all([
      this.crawlQueue.getJobCounts(),
      this.notificationQueue.getJobCounts(),
    ]);

    return {
      crawl: crawlStats,
      notification: notificationStats,
      waiting: crawlStats.waiting + notificationStats.waiting,
      active: crawlStats.active + notificationStats.active,
      completed: crawlStats.completed + notificationStats.completed,
      failed: crawlStats.failed + notificationStats.failed,
    };
  }

  async getActiveJobs() {
    const [crawlJobs, notificationJobs] = await Promise.all([
      this.crawlQueue.getActive(),
      this.notificationQueue.getActive(),
    ]);

    return [
      ...crawlJobs.map((job) => ({
        id: job.id,
        name: job.name,
        queue: 'crawl',
        data: job.data,
        progress: job.progress(),
        timestamp: job.timestamp,
      })),
      ...notificationJobs.map((job) => ({
        id: job.id,
        name: job.name,
        queue: 'notification',
        data: job.data,
        progress: job.progress(),
        timestamp: job.timestamp,
      })),
    ];
  }

  // Get job by ID
  async getJob(queueType, jobId) {
    const queue =
      queueType === 'crawl' ? this.crawlQueue : this.notificationQueue;
    return await queue.getJob(jobId);
  }

  // Cancel a job
  async cancelJob(queueType, jobId) {
    const queue =
      queueType === 'crawl' ? this.crawlQueue : this.notificationQueue;
    const job = await queue.getJob(jobId);

    if (job) {
      if (queueType === 'crawl' && (await job.getState()) === 'active') {
        await this.requestCrawlCancellation(jobId);
        return true;
      }
      await job.remove();
      console.log(`Cancelled job ${jobId} from ${queueType} queue`);
      return true;
    }

    return false;
  }

  // Retry a failed job
  async retryJob(queueType, jobId) {
    const queue =
      queueType === 'crawl' ? this.crawlQueue : this.notificationQueue;
    const job = await queue.getJob(jobId);

    if (job && job.failedReason) {
      if (queueType !== 'crawl' || job.name !== 'crawl-website') {
        await job.retry();
        console.log(`Retried job ${jobId} from ${queueType} queue`);
        return true;
      }

      await this.withCrawlAdmissionLock(async (assertLockOwned) => {
        const currentJob = await this.crawlQueue.getJob(jobId);
        if (!currentJob || !currentJob.failedReason) {
          throw new QueueAdmissionError(
            'This crawl is no longer available to retry.',
            409,
            'CRAWL_RETRY_NOT_AVAILABLE'
          );
        }

        const pendingJobs = await this.crawlQueue.getJobs(
          ACTIVE_CRAWL_STATES,
          0,
          -1
        );
        const pendingCrawls = pendingJobs.filter(
          (pendingJob) =>
            pendingJob.name === 'crawl-website' && pendingJob.id !== jobId
        );
        if (
          pendingCrawls.some(
            (pendingJob) =>
              pendingJob.data.websiteId === currentJob.data.websiteId
          )
        ) {
          throw new QueueAdmissionError(
            'A crawl is already queued or running for this website.',
            409,
            'CRAWL_ALREADY_ACTIVE'
          );
        }

        const userPendingCount = pendingCrawls.filter(
          (pendingJob) => pendingJob.data.userId === currentJob.data.userId
        ).length;
        if (userPendingCount >= config.crawler.maxActiveJobsPerUser) {
          throw new QueueAdmissionError(
            `You have reached the limit of ${config.crawler.maxActiveJobsPerUser} active crawl jobs. Wait for a crawl to finish before starting another.`,
            429,
            'CRAWL_ACTIVE_LIMIT_REACHED'
          );
        }

        await assertLockOwned();
        await currentJob.retry();
      });
      console.log(`Retried job ${jobId} from ${queueType} queue`);
      return true;
    }

    return false;
  }

  // Clean old jobs
  async cleanOldJobs() {
    try {
      // Clean completed jobs older than 24 hours
      await this.crawlQueue.clean(24 * 60 * 60 * 1000, 'completed');
      await this.notificationQueue.clean(24 * 60 * 60 * 1000, 'completed');

      // Clean failed jobs older than 7 days
      await this.crawlQueue.clean(7 * 24 * 60 * 60 * 1000, 'failed');
      await this.notificationQueue.clean(7 * 24 * 60 * 60 * 1000, 'failed');

      console.log('Cleaned old jobs from queues');
    } catch (error) {
      console.error('Failed to clean old jobs:', error);
    }
  }

  // Helper methods
  getPriorityValue(priority) {
    const priorities = {
      low: 1,
      normal: 5,
      high: 10,
      critical: 15,
    };
    return priorities[priority] || priorities.normal;
  }

  getCronPattern(frequency) {
    const patterns = {
      daily: '0 2 * * *', // 2 AM daily
      weekly: '0 2 * * 0', // 2 AM every Sunday
      monthly: '0 2 1 * *', // 2 AM on the 1st of every month
    };
    return patterns[frequency] || patterns.weekly;
  }

  // Graceful shutdown
  async close() {
    try {
      await Promise.all([
        this.crawlQueue.close(),
        this.notificationQueue.close(),
      ]);
      console.log('Queue service closed gracefully');
    } catch (error) {
      console.error('Error closing queue service:', error);
    }
  }
}

const acquireCrawlExecutionSlot = (userId, signal, onLeaseLost) =>
  QueueService.prototype.acquireCrawlExecutionSlot.call(
    { crawlQueue },
    userId,
    signal,
    onLeaseLost
  );
const watchCrawlCancellation = (jobId, controller) =>
  QueueService.prototype.watchCrawlCancellation.call(
    { crawlQueue },
    jobId,
    controller
  );
const clearCrawlCancellation = (jobId) =>
  QueueService.prototype.clearCrawlCancellation.call({ crawlQueue }, jobId);

module.exports = {
  QueueAdmissionError,
  QueueService,
  acquireCrawlExecutionSlot,
  watchCrawlCancellation,
  clearCrawlCancellation,
  crawlQueue,
  notificationQueue,
};
