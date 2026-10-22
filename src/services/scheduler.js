const cron = require('node-cron');
const prisma = require('../lib/prisma');

class SchedulerService {
  constructor(queueService) {
    this.queueService = queueService;
    this.scheduledTasks = new Map();
    this.isRunning = false;
  }

  start() {
    console.log('Starting scheduler service...');

    // Schedule recurring crawls check every hour
    this.scheduledTasks.set(
      'recurring-crawls',
      cron.schedule(
        '0 * * * *',
        async () => {
          await this.scheduleRecurringCrawls();
        },
        {
          scheduled: false,
        }
      )
    );

    // Schedule queue cleanup daily at 3 AM
    this.scheduledTasks.set(
      'queue-cleanup',
      cron.schedule(
        '0 3 * * *',
        async () => {
          await this.queueService.cleanOldJobs();
        },
        {
          scheduled: false,
        }
      )
    );

    // Schedule health check every 30 minutes
    this.scheduledTasks.set(
      'health-check',
      cron.schedule(
        '*/30 * * * *',
        async () => {
          await this.performHealthCheck();
        },
        {
          scheduled: false,
        }
      )
    );

    // Start all scheduled tasks
    this.scheduledTasks.forEach((task, name) => {
      task.start();
      console.log(`Scheduled task '${name}' started`);
    });

    // Run initial setup
    this.scheduleRecurringCrawls();

    this.isRunning = true;
    console.log('Scheduler service started successfully');
  }

  async stop() {
    console.log('Stopping scheduler service...');

    // Stop all scheduled tasks
    this.scheduledTasks.forEach((task, name) => {
      task.stop();
      console.log(`Scheduled task '${name}' stopped`);
    });

    this.scheduledTasks.clear();
    this.isRunning = false;
    console.log('Scheduler service stopped');
  }

  async scheduleRecurringCrawls() {
    try {
      console.log('Checking for websites that need crawling...');

      // Find websites that need to be crawled (only those with automatic crawling enabled)
      const websitesToCrawl = await prisma.website.findMany({
        where: {
          isActive: true,
          crawlFrequency: { not: null },
          nextCrawlAt: { lte: new Date() },
        },
        select: {
          id: true,
          userId: true,
          name: true,
          url: true,
          crawlFrequency: true,
          nextCrawlAt: true,
        },
      });

      console.log(
        `Found ${websitesToCrawl.length} websites that need crawling`
      );

      for (const website of websitesToCrawl) {
        try {
          // Add crawl job to queue
          await this.queueService.addCrawlJob(website.id, website.userId, {
            crawlDepth: 1,
            priority: 'normal',
            scheduledBy: 'cron',
          });

          // Update next crawl time
          const nextCrawlAt = this.calculateNextCrawlTime(
            website.crawlFrequency
          );
          await prisma.website.update({
            where: { id: website.id },
            data: { nextCrawlAt },
          });

          console.log(
            `Scheduled crawl for website ${website.name} (${website.id})`
          );
        } catch (error) {
          console.error(
            `Failed to schedule crawl for website ${website.id}:`,
            error
          );
        }
      }
    } catch (error) {
      console.error('Failed to schedule recurring crawls:', error);
    }
  }

  calculateNextCrawlTime(frequency) {
    const now = new Date();
    const nextCrawl = new Date(now);

    switch (frequency) {
      case 'daily':
        nextCrawl.setDate(now.getDate() + 1);
        break;
      case 'weekly':
        nextCrawl.setDate(now.getDate() + 7);
        break;
      case 'monthly':
        nextCrawl.setMonth(now.getMonth() + 1);
        break;
      default:
        nextCrawl.setDate(now.getDate() + 7); // Default to weekly
    }

    // Set to 2 AM to avoid peak hours
    nextCrawl.setHours(2, 0, 0, 0);

    return nextCrawl;
  }

  async performHealthCheck() {
    try {
      console.log('Performing system health check...');

      // Check queue health
      const queueStats = await this.queueService.getQueueStats();

      // Log warnings for high queue sizes
      if (queueStats.crawl.waiting > 100) {
        console.warn(
          `High number of waiting crawl jobs: ${queueStats.crawl.waiting}`
        );
      }

      if (queueStats.crawl.failed > 50) {
        console.warn(
          `High number of failed crawl jobs: ${queueStats.crawl.failed}`
        );
      }

      if (queueStats.notification.waiting > 50) {
        console.warn(
          `High number of waiting notification jobs: ${queueStats.notification.waiting}`
        );
      }

      // Check for stalled websites (not crawled in a long time)
      const staleCrawlThreshold = new Date();
      staleCrawlThreshold.setDate(staleCrawlThreshold.getDate() - 30); // 30 days

      const staleWebsites = await prisma.website.count({
        where: {
          isActive: true,
          OR: [
            { lastCrawledAt: null },
            { lastCrawledAt: { lt: staleCrawlThreshold } },
          ],
        },
      });

      if (staleWebsites > 0) {
        console.warn(
          `Found ${staleWebsites} websites that haven't been crawled in 30+ days`
        );
      }

      console.log('Health check completed');
    } catch (error) {
      console.error('Health check failed:', error);
    }
  }

  // Manual trigger for recurring crawls (useful for testing)
  async triggerRecurringCrawls() {
    if (!this.isRunning) {
      throw new Error('Scheduler service is not running');
    }

    await this.scheduleRecurringCrawls();
  }

  // Get scheduler status
  getStatus() {
    return {
      isRunning: this.isRunning,
      scheduledTasks: Array.from(this.scheduledTasks.keys()),
      taskCount: this.scheduledTasks.size,
    };
  }

  // Add a custom scheduled task
  addCustomTask(name, cronExpression, taskFunction) {
    if (this.scheduledTasks.has(name)) {
      throw new Error(`Task '${name}' already exists`);
    }

    const task = cron.schedule(cronExpression, taskFunction, {
      scheduled: this.isRunning,
    });

    this.scheduledTasks.set(name, task);

    if (this.isRunning) {
      task.start();
    }

    console.log(
      `Custom task '${name}' added with expression '${cronExpression}'`
    );
  }

  // Remove a custom scheduled task
  removeCustomTask(name) {
    const task = this.scheduledTasks.get(name);
    if (task) {
      task.stop();
      this.scheduledTasks.delete(name);
      console.log(`Custom task '${name}' removed`);
      return true;
    }
    return false;
  }
}

module.exports = SchedulerService;
