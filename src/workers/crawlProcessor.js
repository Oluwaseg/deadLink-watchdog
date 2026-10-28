const {
  acquireCrawlExecutionSlot,
  clearCrawlCancellation,
  crawlQueue,
  watchCrawlCancellation,
} = require('../services/queue');
const prisma = require('../lib/prisma');
const WebCrawler = require('../services/crawler');
const emailService = require('../services/email');
const config = require('../../config/config');
const { toPrismaErrorType } = require('../utils/errorType');
const { requestPublicUrl } = require('../services/outboundUrlPolicy');
const { publishCrawlEvent } = require('../services/realtime');
const {
  CrawlCancellationError,
  CrawlLeaseLostError,
  raceWithAbort,
  throwIfAborted,
} = require('../services/crawlCancellation');

const CRAWL_TIMEOUT_MS = 5 * 60 * 1000;

class CrawlProcessor {
  constructor() {
    this.crawler = new WebCrawler();
    this.isProcessing = false;
    this.crawlTimeoutMs = CRAWL_TIMEOUT_MS;
  }

  async start() {
    console.log('Starting crawl processor...');

    console.log('Checking Redis connection for crawl queue...');
    await new Promise((resolve, reject) => {
      crawlQueue.client.ping((error, result) => {
        if (error) reject(error);
        else resolve(result);
      });
    });
    console.log('Redis connection successful.');

    // Process crawl jobs
    console.log('🔧 Setting up job processor for "crawl-website" jobs...');
    console.log(`🔧 Max concurrent jobs: ${config.crawler.maxConcurrent}`);

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
          const result = await processor.processQueuedCrawl(job);
          console.log(`✅ Job ${job.id} completed successfully`);
          return result;
        } catch (error) {
          console.error(`❌ Job ${job.id} failed:`, error.message);
          throw error;
        }
      }
    );

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
          `⚠️ Found ${waiting.length} waiting jobs but no active jobs. Bull stalled-job recovery remains responsible for processing them.`
        );
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
    const controller = new AbortController();
    const stopWatchingCancellation = await watchCrawlCancellation(
      job.id,
      controller
    );
    let executionSlot;
    let timeout;
    let onLockLost;
    try {
      executionSlot = await acquireCrawlExecutionSlot(
        job.data.userId,
        controller.signal,
        (leaseError) => {
          if (!controller.signal.aborted) {
            controller.abort(
              new CrawlCancellationError(
                'lease_lost',
                `Crawl execution lease was lost: ${leaseError?.message || 'renewal failed'}`
              )
            );
          }
        }
      );
      onLockLost = (lostJob, lockError) => {
        if (lostJob?.id === job.id && !controller.signal.aborted) {
          controller.abort(
            new CrawlCancellationError(
              'cancelled',
              `Crawl worker lost its Bull lock: ${lockError?.message || 'lock renewal failed'}`
            )
          );
        }
      };
      crawlQueue.on('lock-extension-failed', onLockLost);
      timeout = setTimeout(() => {
        controller.abort(new CrawlCancellationError('timeout'));
      }, this.crawlTimeoutMs);
      return await this.processCrawlJob(
        job,
        isManualProcessing,
        controller.signal,
        () => clearTimeout(timeout)
      );
    } catch (error) {
      if (controller.signal.aborted) {
        const cancellation = controller.signal.reason;
        if (cancellation?.reason !== 'lease_lost') {
          job.discard?.();
        }
        return {
          success: false,
          cancelled: cancellation?.reason === 'cancelled',
          timedOut: cancellation?.reason === 'timeout',
          leaseLost: cancellation?.reason === 'lease_lost',
          terminationReason: cancellation?.reason || 'cancelled',
          errorMessage: cancellation?.message || 'Crawl was cancelled.',
        };
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      if (onLockLost) {
        crawlQueue.removeListener('lock-extension-failed', onLockLost);
      }
      await stopWatchingCancellation();
      await clearCrawlCancellation(job.id);
      if (executionSlot?.leaseLost) {
        console.error(
          `Per-user crawl execution lease was lost for job ${job.id}`
        );
      }
      await executionSlot?.release();
    }
  }

  async processQueuedCrawl(job) {
    const result = await this.processWithUserExecutionSlot(job);
    if (
      result?.terminationReason === 'timeout' ||
      result?.terminationReason === 'cancelled'
    ) {
      job.discard?.();
      throw new CrawlCancellationError(
        result.terminationReason,
        result.errorMessage
      );
    }
    if (result?.terminationReason === 'lease_lost') {
      throw new CrawlLeaseLostError(result.errorMessage);
    }
    return result;
  }

  async acquireCrawlResult(
    job,
    website,
    { userId, crawlDepth, scheduledBy, retryCrawlResultId }
  ) {
    if (
      job.id === undefined ||
      job.id === null ||
      String(job.id).trim() === ''
    ) {
      throw new Error('Bull crawl job is missing its job ID.');
    }
    const bullJobId = String(job.id);
    const resultData = {
      websiteId: website.id,
      userId,
      status: 'running',
      startedAt: new Date(),
      crawlDepth,
      userAgent: config.crawler.userAgent,
      summary: { scheduledBy, jobId: bullJobId },
    };

    const assertResultOwner = (result) => {
      if (
        !result ||
        result.websiteId !== website.id ||
        result.userId !== userId ||
        (retryCrawlResultId && result.id !== retryCrawlResultId)
      ) {
        throw new Error(
          'Retry crawl result does not match the queued website.'
        );
      }
    };

    try {
      return await prisma.$transaction(async (transaction) => {
        const association = await transaction.crawlJobResult.findUnique({
          where: { bullJobId },
          include: { crawlResult: true },
        });
        let crawlResult = association?.crawlResult || null;

        if (
          association &&
          retryCrawlResultId &&
          crawlResult.id !== retryCrawlResultId
        ) {
          throw new Error(
            'Bull job is already associated with a different crawl result.'
          );
        }

        if (!crawlResult && retryCrawlResultId) {
          crawlResult = await transaction.crawlResult.findUnique({
            where: { id: retryCrawlResultId },
          });
          if (!crawlResult)
            throw new Error('Retry crawl result no longer exists.');
        }

        if (!crawlResult) {
          crawlResult = await transaction.crawlResult.create({
            data: resultData,
          });
        } else if (crawlResult.status === 'completed') {
          assertResultOwner(crawlResult);
          if (!association) {
            await transaction.crawlJobResult.create({
              data: { bullJobId, crawlResultId: crawlResult.id },
            });
          }
          return crawlResult;
        } else {
          crawlResult = await transaction.crawlResult.update({
            where: { id: crawlResult.id },
            data: {
              status: 'running',
              startedAt: new Date(),
              completedAt: null,
              errorMessage: null,
              crawlDepth,
              userAgent: config.crawler.userAgent,
              summary: {
                ...(crawlResult.summary || {}),
                scheduledBy,
                jobId: bullJobId,
              },
            },
          });
        }

        assertResultOwner(crawlResult);
        if (!association) {
          await transaction.crawlJobResult.create({
            data: { bullJobId, crawlResultId: crawlResult.id },
          });
        }
        return crawlResult;
      });
    } catch (error) {
      if (error.code !== 'P2002') throw error;

      // Another transaction may have created this job association first. Its result is canonical.
      const association = await prisma.crawlJobResult.findUnique({
        where: { bullJobId },
        include: { crawlResult: true },
      });
      if (!association) throw error;
      assertResultOwner(association.crawlResult);
      return association.crawlResult;
    }
  }

  async processCrawlJob(
    job,
    isManualProcessing = false,
    signal = null,
    onCrawlFinished = () => {}
  ) {
    const {
      websiteId,
      userId,
      crawlDepth = 1,
      scheduledBy = 'manual',
      crawlResultId: retryCrawlResultId,
    } = job.data;

    console.log(`Processing crawl job ${job.id} for website ${websiteId}`);

    try {
      throwIfAborted(signal);
      // Get website details
      const website = await prisma.website.findUnique({
        where: { id: websiteId },
      });
      throwIfAborted(signal);
      if (!website) {
        throw new Error(`Website ${websiteId} not found`);
      }

      if (!website.isActive) {
        throw new Error(`Website ${websiteId} is not active`);
      }

      let crawlResult = await this.acquireCrawlResult(job, website, {
        userId,
        crawlDepth,
        scheduledBy,
        retryCrawlResultId,
      });

      if (crawlResult.status === 'completed') {
        console.log(
          `Crawl result already exists for job ${job.id}, skipping...`
        );
        return {
          success: true,
          crawlResultId: crawlResult.id,
          message: 'Crawl result already exists',
        };
      }
      throwIfAborted(signal);

      let lastPublishedProgress = 0;
      let publishChain = Promise.resolve();
      const publish = (event) => {
        publishChain = publishChain
          .then(() => {
            if (signal?.aborted && event.status !== 'failed') return false;
            return publishCrawlEvent({
              crawlId: crawlResult.id,
              websiteId,
              userId,
              ...event,
            });
          })
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
        throwIfAborted(signal);
        console.log(`Starting crawl for website: ${website.url}`);

        const crawlPromise = this.crawler.crawlWebsite(website.url, {
          depth: crawlDepth,
          signal,
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

        let crawlData;
        try {
          crawlData = await raceWithAbort(crawlPromise, signal);
        } catch (error) {
          if (!signal?.aborted) throw error;
          await crawlPromise.catch(() => {});
          throw signal.reason instanceof Error ? signal.reason : error;
        }
        onCrawlFinished();
        throwIfAborted(signal);
        const budgetTermination = crawlData.terminationReason;
        const budgetTerminationMessage = budgetTermination
          ? budgetTermination === 'max_pages_reached'
            ? `Crawl stopped after reaching the ${config.crawler.maxPagesPerCrawl}-page limit; results are partial.`
            : `Crawl stopped after reaching the ${config.crawler.maxNetworkRequestsPerCrawl}-network-request limit; results are partial.`
          : null;
        console.log(
          `${budgetTermination ? 'Crawl stopped early' : 'Crawl completed'} for ${website.url}: ${crawlData.totalLinksFound} links found, ${crawlData.brokenLinksFound} broken`
        );

        if (!isManualProcessing) {
          job.progress(90);
        }
        if (lastPublishedProgress < 90) {
          lastPublishedProgress = 90;
          publish({ status: 'running', progress: 90 });
        }

        const brokenLinksByIdentity = new Map();
        for (const link of crawlData.brokenLinks || []) {
          const errorType = toPrismaErrorType(link.errorType);
          const identity = JSON.stringify([
            link.url,
            link.sourceUrl,
            errorType,
          ]);
          brokenLinksByIdentity.set(identity, {
            websiteId,
            crawlResultId: crawlResult.id,
            url: link.url,
            sourceUrl: link.sourceUrl,
            linkText: link.linkText,
            statusCode: link.statusCode,
            errorType,
            errorMessage: link.errorMessage,
            responseTime: link.responseTime,
            redirectChain: link.redirectChain || [],
          });
        }
        const brokenLinksData = [...brokenLinksByIdentity.values()];

        // Lock and replace persistence for this crawl atomically before exposing a terminal status.
        const persistence = await prisma.$transaction(async (transaction) => {
          await transaction.$queryRaw`
            SELECT "id" FROM "crawl_results" WHERE "id" = ${crawlResult.id}::uuid FOR UPDATE
          `;
          const currentResult = await transaction.crawlResult.findUnique({
            where: { id: crawlResult.id },
          });
          if (!currentResult || currentResult.status !== 'running') {
            return { claimed: false, crawlResult: currentResult };
          }

          throwIfAborted(signal);
          await transaction.brokenLink.deleteMany({
            where: { crawlResultId: crawlResult.id },
          });
          if (brokenLinksData.length > 0) {
            await transaction.brokenLink.createMany({ data: brokenLinksData });
          }
          throwIfAborted(signal);

          if (!budgetTermination) {
            await this.updateWebsiteStats(transaction, website, crawlData);
          }
          throwIfAborted(signal);

          const terminalUpdate = await transaction.crawlResult.updateMany({
            where: { id: crawlResult.id, status: 'running' },
            data: {
              status: budgetTermination ? 'failed' : 'completed',
              completedAt: new Date(),
              errorMessage: budgetTerminationMessage,
              totalLinksFound: crawlData.totalLinksFound,
              totalLinksChecked: crawlData.totalLinksChecked,
              brokenLinksFound: crawlData.brokenLinksFound,
              redirectsFound: crawlData.redirectsFound,
              timeoutsFound: crawlData.timeoutsFound,
              averageResponseTime: crawlData.averageResponseTime,
              summary: {
                ...(currentResult.summary || {}),
                crawlDuration: crawlData.endTime - crawlData.startTime,
                errors: crawlData.errors,
                budget: crawlData.budget,
                terminationReason: budgetTermination,
              },
            },
          });
          if (terminalUpdate.count !== 1) {
            throw new Error(
              'Crawl result changed before persistence completed.'
            );
          }

          const persistedResult = await transaction.crawlResult.findUnique({
            where: { id: crawlResult.id },
          });
          const expectedStatus = budgetTermination ? 'failed' : 'completed';
          if (persistedResult?.status !== expectedStatus) {
            throw new Error(
              'Crawl terminal status was not confirmed in the transaction.'
            );
          }
          return {
            claimed: true,
            crawlResult: persistedResult,
          };
        });

        crawlResult = persistence.crawlResult;
        if (!persistence.claimed) {
          if (crawlResult?.status === 'failed') {
            return {
              success: false,
              crawlResultId: crawlResult.id,
              terminationReason:
                crawlResult.summary?.terminationReason || 'cancelled',
              errorMessage: crawlResult.errorMessage,
            };
          }
          return {
            success: crawlResult?.status === 'completed',
            crawlResultId: crawlResult?.id || retryCrawlResultId,
            message: 'Crawl result was already finalized',
          };
        }

        if (budgetTermination) {
          await publish({
            status: 'failed',
            progress: lastPublishedProgress,
            completedAt: crawlResult.completedAt.toISOString(),
            errorMessage: budgetTerminationMessage,
          });
        } else {
          await publish({
            status: 'completed',
            progress: 100,
            completedAt: crawlResult.completedAt.toISOString(),
            totalLinksFound: crawlData.totalLinksFound,
            totalLinksChecked: crawlData.totalLinksChecked,
            brokenLinksFound: crawlData.brokenLinksFound,
          });
        }

        if (!isManualProcessing) {
          job.progress(95);
        }

        // Send email notifications if there are broken links or if it's a scheduled crawl
        if (
          !budgetTermination &&
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
        if (!budgetTermination && website.webhookUrl) {
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

        if (budgetTermination) {
          return {
            success: false,
            crawlResultId: crawlResult.id,
            terminationReason: budgetTermination,
            errorMessage: budgetTerminationMessage,
          };
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
        if (
          signal?.reason?.reason === 'lease_lost' ||
          crawlError.code === 'CRAWL_LEASE_LOST'
        ) {
          throw new CrawlLeaseLostError(
            signal?.reason?.message || crawlError.message
          );
        }
        if (signal?.aborted || crawlError.code === 'CRAWL_CANCELLED') {
          await job.discard?.();
          const cancellation = signal?.reason || crawlError;
          const terminationReason = cancellation.reason || 'cancelled';
          const message = cancellation.message || 'Crawl was cancelled.';
          const terminalUpdate = await prisma.crawlResult.updateMany({
            where: { id: crawlResult.id, status: 'running' },
            data: {
              status: 'failed',
              completedAt: new Date(),
              errorMessage: message,
              summary: {
                ...(crawlResult.summary || {}),
                terminationReason,
              },
            },
          });
          const terminalResult = await prisma.crawlResult.findUnique({
            where: { id: crawlResult.id },
          });
          if (
            terminalUpdate.count === 0 &&
            terminalResult?.status === 'completed'
          ) {
            return {
              success: true,
              crawlResultId: terminalResult.id,
              message: 'Crawl completed before cancellation was recorded',
            };
          }
          if (terminalUpdate.count === 0) {
            return {
              success: false,
              crawlResultId: terminalResult?.id || crawlResult.id,
              terminationReason:
                terminalResult?.summary?.terminationReason || terminationReason,
              errorMessage: terminalResult?.errorMessage || message,
            };
          }
          await publish({
            status: 'failed',
            progress: lastPublishedProgress,
            completedAt: terminalResult.completedAt.toISOString(),
            errorMessage: message,
          });
          return {
            success: false,
            crawlResultId: terminalResult.id,
            terminationReason,
            errorMessage: message,
          };
        }

        const failureUpdate = await prisma.crawlResult.updateMany({
          where: { id: crawlResult.id, status: 'running' },
          data: {
            status: 'failed',
            completedAt: new Date(),
            errorMessage: crawlError.message,
          },
        });
        const storedResult = await prisma.crawlResult.findUnique({
          where: { id: crawlResult.id },
        });
        if (failureUpdate.count === 0 && storedResult?.status === 'completed') {
          return {
            success: true,
            crawlResultId: storedResult.id,
            message: 'Crawl completed before the worker error was recorded',
          };
        }

        await publish({
          status: 'failed',
          progress: lastPublishedProgress,
          completedAt:
            storedResult?.completedAt?.toISOString() ||
            new Date().toISOString(),
          errorMessage: storedResult?.errorMessage || crawlError.message,
        });

        throw crawlError;
      }
    } catch (error) {
      console.error(`Crawl job ${job.id} failed:`, error);
      throw error;
    }
  }

  async updateWebsiteStats(transaction, website, crawlData) {
    const updateData = {
      lastCrawledAt: new Date(),
      totalLinks: crawlData.totalLinksChecked,
      brokenLinks: crawlData.brokenLinksFound,
      nextCrawlAt: this.calculateNextCrawlTime(website.crawlFrequency),
    };

    if (crawlData.totalLinksChecked > 0) {
      const healthScore = Math.max(
        0,
        100 - (crawlData.brokenLinksFound / crawlData.totalLinksChecked) * 100
      );
      updateData.healthScore = Math.round(healthScore * 100) / 100;
    }

    await transaction.website.update({
      where: { id: website.id },
      data: updateData,
    });
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
      const response = await requestPublicUrl(website.webhookUrl, {
        method: 'post',
        data: webhookPayload,
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
