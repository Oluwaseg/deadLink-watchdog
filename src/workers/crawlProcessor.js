const { acquireCrawlExecutionSlot, crawlQueue } = require('../services/queue');
const prisma = require('../lib/prisma');
const WebCrawler = require('../services/crawler');
const emailService = require('../services/email');
const config = require('../../config/config');
const { toPrismaErrorType } = require('../utils/errorType');
const { publishCrawlEvent } = require('../services/realtime');

class CrawlProcessor {
  constructor() {
    this.crawler = new WebCrawler();
    this.isProcessing = false;
  }

  async start() {
    console.log('Starting crawl processor...');

    // Check Redis connection
    console.log('🔗 Checking Redis connection for crawl queue...');
    crawlQueue.client.ping((err, result) => {
      if (err) {
        console.error('❌ Redis connection error:', err);
      } else {
        console.log('✅ Redis connection successful:', result);
      }
    });

    // Process crawl jobs
    console.log('🔧 Setting up job processor for "crawl-website" jobs...');
    console.log(`🔧 Max concurrent jobs: ${config.crawler.maxConcurrent}`);

    // Test if the queue is working by adding a simple test job
    console.log('🧪 Testing queue by adding a test job...');
    await crawlQueue.add('test-job', { test: true }, { delay: 1000 });

    // Store reference to this for use in job handlers
    const processor = this;

    crawlQueue.process(
      'crawl-website',
      config.crawler.maxConcurrent,
      async (job) => {
        console.log(
          `🔄 Worker picked up job ${job.id} for website ${job.data.websiteId}`
        );
        try {
          const result = await processor.processWithUserExecutionSlot(job);
          console.log(`✅ Job ${job.id} completed successfully`);
          return result;
        } catch (error) {
          console.error(`❌ Job ${job.id} failed:`, error.message);
          throw error;
        }
      }
    );

    // Also process test jobs
    crawlQueue.process('test-job', 1, async (job) => {
      console.log(`🧪 Test job processed: ${job.id}`);

      // Test the crawler
      try {
        console.log('🧪 Testing crawler initialization...');
        await processor.crawler.initialize();
        console.log('✅ Crawler initialized successfully');

        console.log('🧪 Testing simple link check...');
        const testResult =
          await processor.crawler.checkLink('https://google.com');
        console.log('✅ Link check successful:', testResult.status);

        await processor.crawler.close();
        console.log('✅ Crawler closed successfully');
      } catch (error) {
        console.error('❌ Crawler test failed:', error.message);
      }

      return { test: 'success' };
    });

    // Set up event listeners
    crawlQueue.on('completed', (job, result) => {
      console.log(`✅ Crawl job ${job.id} completed successfully`);
    });

    crawlQueue.on('failed', (job, err) => {
      console.error(`❌ Crawl job ${job.id} failed:`, err.message);
    });

    crawlQueue.on('stalled', (job) => {
      console.warn(`⚠️ Crawl job ${job.id} stalled`);
    });

    crawlQueue.on('waiting', (jobId) => {
      console.log(`⏳ Job ${jobId} is waiting in queue`);
    });

    crawlQueue.on('active', (job, jobPromise) => {
      console.log(`🚀 Job ${job.id} started processing`);
    });

    this.isProcessing = true;
    console.log('✅ Crawl processor started successfully');

    // Log current queue stats and check queue health
    setTimeout(() => {
      this.logQueueStats();
      this.checkQueueHealth();
    }, 1000);

    // Set up periodic queue monitoring
    setInterval(() => {
      this.logQueueStats();
      this.checkQueueHealth();
    }, 30000); // Check every 30 seconds
  }

  async logQueueStats() {
    try {
      const waiting = await crawlQueue.getWaiting();
      const active = await crawlQueue.getActive();
      const completed = await crawlQueue.getCompleted();
      const failed = await crawlQueue.getFailed();

      console.log(
        `📊 Queue Stats: Waiting: ${waiting.length}, Active: ${active.length}, Completed: ${completed.length}, Failed: ${failed.length}`
      );

      if (waiting.length > 0) {
        console.log(
          `⏳ Waiting jobs:`,
          waiting.map((job) => `${job.id} (${job.data.websiteId})`)
        );
      }
    } catch (error) {
      console.error('Error getting queue stats:', error.message);
    }
  }

  async checkQueueHealth() {
    try {
      const waiting = await crawlQueue.getWaiting();
      const active = await crawlQueue.getActive();

      // Check if queue is paused
      const isPaused = await crawlQueue.isPaused();
      if (isPaused) {
        console.log('⚠️ Queue is paused, resuming...');
        await crawlQueue.resume();
      }

      // If there are waiting jobs but no active jobs, something might be wrong
      if (waiting.length > 0 && active.length === 0) {
        console.log(
          `⚠️ Found ${waiting.length} waiting jobs but no active jobs. Checking queue health...`
        );

        // Try to manually trigger processing of the first job
        const firstJob = waiting[0];
        console.log(`🔧 Attempting to manually trigger job ${firstJob.id}`);

        // Process the job manually as a fallback
        try {
          await this.processWithUserExecutionSlot(firstJob, true);
          await firstJob.remove();
          console.log(`✅ Manually processed job ${firstJob.id}`);
        } catch (error) {
          console.error(
            `❌ Manual processing failed for job ${firstJob.id}:`,
            error.message
          );
          await firstJob.remove(); // Remove failed job
        }
      }
    } catch (error) {
      console.error('Error checking queue health:', error.message);
    }
  }

  async stop() {
    console.log('Stopping crawl processor...');
    this.isProcessing = false;

    // Close the crawler
    await this.crawler.close();

    console.log('Crawl processor stopped');
  }

  async processWithUserExecutionSlot(job, isManualProcessing = false) {
    const executionSlot = await acquireCrawlExecutionSlot(job.data.userId);
    try {
      return await this.processCrawlJob(job, isManualProcessing);
    } finally {
      if (executionSlot.leaseLost) {
        console.error(
          `Per-user crawl execution lease was lost for job ${job.id}`
        );
      }
      await executionSlot.release();
    }
  }

  async processCrawlJob(job, isManualProcessing = false) {
    const {
      websiteId,
      userId,
      crawlDepth = 1,
      scheduledBy = 'manual',
    } = job.data;

    console.log(`Processing crawl job ${job.id} for website ${websiteId}`);

    try {
      // Get website details
      const website = await prisma.website.findUnique({
        where: { id: websiteId },
      });
      if (!website) {
        throw new Error(`Website ${websiteId} not found`);
      }

      if (!website.isActive) {
        throw new Error(`Website ${websiteId} is not active`);
      }

      // Check if a crawl result already exists for this job
      let existingCrawlResult = null;
      try {
        existingCrawlResult = await prisma.crawlResult.findFirst({
          where: {
            summary: {
              path: ['jobId'],
              equals: job.id,
            },
          },
        });
      } catch (jsonFilterError) {
        // Fallback: load recent results and filter in JS
        const recentResults = await prisma.crawlResult.findMany({
          where: { websiteId },
          orderBy: { createdAt: 'desc' },
          take: 50,
        });
        existingCrawlResult = recentResults.find(
          (r) => r.summary && r.summary.jobId === job.id
        );
      }

      if (existingCrawlResult?.status === 'completed') {
        console.log(
          `Crawl result already exists for job ${job.id}, skipping...`
        );
        return {
          success: true,
          crawlResultId: existingCrawlResult.id,
          message: 'Crawl result already exists',
        };
      }

      let crawlResult;
      if (existingCrawlResult) {
        crawlResult = await prisma.crawlResult.update({
          where: { id: existingCrawlResult.id },
          data: {
            status: 'running',
            startedAt: new Date(),
            completedAt: null,
            errorMessage: null,
            crawlDepth,
            userAgent: config.crawler.userAgent,
            summary: {
              ...(existingCrawlResult.summary || {}),
              scheduledBy,
              jobId: job.id,
            },
          },
        });
      } else {
        crawlResult = await prisma.crawlResult.create({
          data: {
            websiteId,
            userId,
            status: 'running',
            startedAt: new Date(),
            crawlDepth,
            userAgent: config.crawler.userAgent,
            summary: {
              scheduledBy,
              jobId: job.id,
            },
          },
        });
      }

      let lastPublishedProgress = 0;
      let publishChain = Promise.resolve();
      const publish = (event) => {
        publishChain = publishChain
          .then(() =>
            publishCrawlEvent({
              crawlId: crawlResult.id,
              websiteId,
              userId,
              ...event,
            })
          )
          .catch((error) => {
            console.error('Failed to publish crawl event:', error.message);
          });
        return publishChain;
      };

      publish({ status: 'running', progress: 0 });

      // Update job progress (only if not manual processing)
      if (!isManualProcessing) {
        job.progress(10);
        lastPublishedProgress = 10;
        publish({ status: 'running', progress: 10 });
      }

      try {
        console.log(`Starting crawl for website: ${website.url}`);

        // Add timeout wrapper for the crawl operation
        const crawlPromise = this.crawler.crawlWebsite(website.url, {
          depth: crawlDepth,
          onProgress: (progress) => {
            console.log(
              `Crawl progress: ${progress.phase} - ${
                progress.message || progress.percentage + '%'
              }`
            );
            if (progress.phase === 'checking') {
              const progressPercentage =
                10 + Math.round(progress.percentage * 0.8); // 10-90%
              const boundedProgress = Math.max(
                10,
                Math.min(90, progressPercentage)
              );
              if (!isManualProcessing) job.progress(boundedProgress);
              if (boundedProgress > lastPublishedProgress) {
                lastPublishedProgress = boundedProgress;
                publish({ status: 'running', progress: boundedProgress });
              }
            }
          },
        });

        // Set a timeout for the entire crawl operation (5 minutes)
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(
            () => {
              reject(new Error('Crawl operation timed out after 5 minutes'));
            },
            5 * 60 * 1000
          );
        });

        const crawlData = await Promise.race([crawlPromise, timeoutPromise]);
        console.log(
          `Crawl completed for ${website.url}: ${crawlData.totalLinksFound} links found, ${crawlData.brokenLinksFound} broken`
        );

        if (!isManualProcessing) {
          job.progress(90);
        }
        if (lastPublishedProgress < 90) {
          lastPublishedProgress = 90;
          publish({ status: 'running', progress: 90 });
        }

        // Update crawl result with data
        crawlResult = await prisma.crawlResult.update({
          where: { id: crawlResult.id },
          data: {
            status: 'completed',
            completedAt: new Date(),
            totalLinksFound: crawlData.totalLinksFound,
            totalLinksChecked: crawlData.totalLinksChecked,
            brokenLinksFound: crawlData.brokenLinksFound,
            redirectsFound: crawlData.redirectsFound,
            timeoutsFound: crawlData.timeoutsFound,
            averageResponseTime: crawlData.averageResponseTime,
            summary: {
              ...(crawlResult.summary || {}),
              crawlDuration: crawlData.endTime - crawlData.startTime,
              errors: crawlData.errors,
            },
          },
        });

        // Save broken links to database
        if (crawlData.brokenLinks && crawlData.brokenLinks.length > 0) {
          const brokenLinksData = crawlData.brokenLinks.map((link) => ({
            websiteId,
            crawlResultId: crawlResult.id,
            url: link.url,
            sourceUrl: link.sourceUrl,
            linkText: link.linkText,
            statusCode: link.statusCode,
            errorType: toPrismaErrorType(link.errorType),
            errorMessage: link.errorMessage,
            responseTime: link.responseTime,
            redirectChain: link.redirectChain || [],
          }));

          await prisma.brokenLink.createMany({ data: brokenLinksData });
        }

        // Update website statistics
        await this.updateWebsiteStats(website, crawlData);

        await publish({
          status: 'completed',
          progress: 100,
          completedAt: crawlResult.completedAt.toISOString(),
          totalLinksFound: crawlData.totalLinksFound,
          totalLinksChecked: crawlData.totalLinksChecked,
          brokenLinksFound: crawlData.brokenLinksFound,
        });

        if (!isManualProcessing) {
          job.progress(95);
        }

        // Send email notifications if there are broken links or if it's a scheduled crawl
        if (
          (crawlData.brokenLinksFound > 0 || scheduledBy === 'cron') &&
          website.notificationEmail
        ) {
          try {
            console.log(
              `📧 Sending crawl notification to ${website.notificationEmail}`
            );
            const user = await prisma.user.findUnique({
              where: { id: userId },
              select: { firstName: true },
            });
            await emailService.sendCrawlNotification(
              website.notificationEmail,
              website,
              crawlResult,
              user?.firstName || ''
            );
          } catch (notificationError) {
            console.error(
              'Failed to send email notification:',
              notificationError
            );
            // Don't fail the job if notification fails
          }
        }

        // Send webhook notification if configured
        if (website.webhookUrl) {
          try {
            console.log(
              `🪝 Sending webhook notification to ${website.webhookUrl}`
            );
            await this.sendWebhookNotification(
              website,
              crawlResult,
              crawlData.brokenLinks
            );
          } catch (webhookError) {
            console.error('Failed to send webhook notification:', webhookError);
            // Don't fail the job if webhook fails
          }
        }

        if (!isManualProcessing) {
          job.progress(100);
        }

        console.log(
          `Crawl completed for website ${websiteId}: ${crawlData.brokenLinksFound} broken links found`
        );

        return {
          success: true,
          crawlResultId: crawlResult.id,
          brokenLinksFound: crawlData.brokenLinksFound,
          totalLinksChecked: crawlData.totalLinksChecked,
        };
      } catch (crawlError) {
        // Update crawl result as failed
        await prisma.crawlResult.update({
          where: { id: crawlResult.id },
          data: {
            status: 'failed',
            completedAt: new Date(),
            errorMessage: crawlError.message,
          },
        });

        await publish({
          status: 'failed',
          progress: lastPublishedProgress,
          completedAt: new Date().toISOString(),
          errorMessage: crawlError.message,
        });

        throw crawlError;
      }
    } catch (error) {
      console.error(`Crawl job ${job.id} failed:`, error);
      throw error;
    }
  }

  async updateWebsiteStats(website, crawlData) {
    try {
      const updateData = {
        lastCrawledAt: new Date(),
        totalLinks: crawlData.totalLinksChecked,
        brokenLinks: crawlData.brokenLinksFound,
      };

      // Calculate next crawl time based on frequency
      const nextCrawlAt = this.calculateNextCrawlTime(website.crawlFrequency);
      updateData.nextCrawlAt = nextCrawlAt;

      // Update health score
      if (crawlData.totalLinksChecked > 0) {
        const healthScore = Math.max(
          0,
          100 - (crawlData.brokenLinksFound / crawlData.totalLinksChecked) * 100
        );
        updateData.healthScore = Math.round(healthScore * 100) / 100;
      }

      await prisma.website.update({
        where: { id: website.id },
        data: updateData,
      });

      console.log(
        `Updated stats for website ${website.id}: Health Score ${updateData.healthScore}%`
      );
    } catch (error) {
      console.error('Failed to update website stats:', error);
      // Don't throw error as this shouldn't fail the crawl job
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

  async sendWebhookNotification(website, crawlResult, brokenLinks) {
    const axios = require('axios');

    const webhookPayload = {
      event: 'crawl_completed',
      timestamp: new Date().toISOString(),
      website: {
        id: website.id,
        name: website.name,
        url: website.url,
        category: website.category,
      },
      crawlResult: {
        id: crawlResult.id,
        status: crawlResult.status,
        startedAt: crawlResult.startedAt,
        completedAt: crawlResult.completedAt,
        totalLinksFound: crawlResult.totalLinksFound,
        totalLinksChecked: crawlResult.totalLinksChecked,
        brokenLinksFound: crawlResult.brokenLinksFound,
        redirectsFound: crawlResult.redirectsFound,
        timeoutsFound: crawlResult.timeoutsFound,
        averageResponseTime: crawlResult.averageResponseTime,
        healthScore: website.healthScore,
      },
      brokenLinks: brokenLinks ? brokenLinks.slice(0, 10) : [], // Limit to first 10 broken links
    };

    try {
      const response = await axios.post(website.webhookUrl, webhookPayload, {
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'DeadLink-Watchdog/1.0',
          'X-DeadLink-Event': 'crawl_completed',
        },
        timeout: 10000, // 10 second timeout
      });

      console.log(
        `✅ Webhook sent successfully to ${website.webhookUrl} (Status: ${response.status})`
      );
      return { success: true, status: response.status };
    } catch (error) {
      console.error(
        `❌ Webhook failed for ${website.webhookUrl}:`,
        error.message
      );
      throw error;
    }
  }

  // Health check method
  isHealthy() {
    return this.isProcessing;
  }

  // Get processor statistics
  async getStats() {
    try {
      const [waiting, active, completed, failed] = await Promise.all([
        crawlQueue.getWaiting(),
        crawlQueue.getActive(),
        crawlQueue.getCompleted(),
        crawlQueue.getFailed(),
      ]);

      return {
        waiting: waiting.length,
        active: active.length,
        completed: completed.length,
        failed: failed.length,
        isProcessing: this.isProcessing,
      };
    } catch (error) {
      console.error('Failed to get crawl processor stats:', error);
      return {
        waiting: 0,
        active: 0,
        completed: 0,
        failed: 0,
        isProcessing: this.isProcessing,
        error: error.message,
      };
    }
  }
}

module.exports = CrawlProcessor;
