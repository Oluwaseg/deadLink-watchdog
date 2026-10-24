const Bull = require('bull');
const config = require('../../config/config');

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
    };

    const jobOptions = {
      priority: this.getPriorityValue(options.priority),
      delay: options.delay || 0,
      jobId: `crawl-${websiteId}-${Date.now()}`,
    };

    try {
      const job = await this.crawlQueue.add(
        'crawl-website',
        jobData,
        jobOptions
      );
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
      console.error('Failed to add crawl job:', error);
      throw error;
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
      await job.retry();
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

module.exports = { QueueService, crawlQueue, notificationQueue };
