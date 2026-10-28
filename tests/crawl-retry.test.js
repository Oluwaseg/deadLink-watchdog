const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const Module = require('node:module');
const test = require('node:test');
const {
  CrawlCancellationError,
  CrawlLeaseLostError,
} = require('../src/services/crawlCancellation');
const workerPath = require.resolve('../src/workers/crawlProcessor');

let currentFixture;
const prisma = {
  website: { findUnique: async () => currentFixture.website },
  crawlResult: {
    findFirst: async () => currentFixture.result,
    findMany: async () => [],
    create: async ({ data }) => {
      currentFixture.createCount += 1;
      currentFixture.result = { id: CRAWL_ID, ...data };
      return currentFixture.result;
    },
    update: async ({ data }) => {
      currentFixture.updates.push(data);
      currentFixture.result = { ...currentFixture.result, ...data };
      return currentFixture.result;
    },
    updateMany: async ({ where, data }) => {
      if (
        !currentFixture.result ||
        currentFixture.result.id !== where.id ||
        currentFixture.result.status !== where.status
      ) {
        return { count: 0 };
      }
      if (data.status !== 'running' && currentFixture.failTerminalUpdates > 0) {
        currentFixture.failTerminalUpdates -= 1;
        throw new Error('terminal status persistence failed');
      }
      currentFixture.updates.push(data);
      currentFixture.result = { ...currentFixture.result, ...data };
      return { count: 1 };
    },
    findUnique: async ({ where }) =>
      currentFixture.result?.id === where.id ? currentFixture.result : null,
  },
  crawlJobResult: {
    findUnique: async ({ where, include }) => {
      const crawlResultId = currentFixture.jobAssociations.get(where.bullJobId);
      if (!crawlResultId) return null;
      const association = { bullJobId: where.bullJobId, crawlResultId };
      if (include?.crawlResult) association.crawlResult = currentFixture.result;
      return association;
    },
  },
  brokenLink: {
    deleteMany: async ({ where }) => {
      const before = currentFixture.brokenLinks.length;
      currentFixture.brokenLinks = currentFixture.brokenLinks.filter(
        (link) => link.crawlResultId !== where.crawlResultId
      );
      return { count: before - currentFixture.brokenLinks.length };
    },
    createMany: async ({ data }) => {
      if (currentFixture.failBrokenLinkWrites > 0) {
        currentFixture.failBrokenLinkWrites -= 1;
        if (data.length > 0) currentFixture.brokenLinks.push(data[0]);
        throw new Error('broken-link persistence failed');
      }
      currentFixture.brokenLinks.push(...data);
      return { count: data.length };
    },
  },
  user: { findUnique: async () => ({ firstName: 'Test' }) },
  $transaction: async (callback) => {
    const snapshot = structuredClone({
      result: currentFixture.result,
      jobAssociations: new Map(currentFixture.jobAssociations),
      brokenLinks: currentFixture.brokenLinks,
      website: currentFixture.website,
      updates: currentFixture.updates,
      websiteStatsUpdateCount: currentFixture.websiteStatsUpdateCount,
    });
    const transaction = {
      $queryRaw: async () => [],
      crawlResult: prisma.crawlResult,
      crawlJobResult: {
        findUnique: prisma.crawlJobResult.findUnique,
        create: async ({ data }) => {
          if (currentFixture.jobAssociations.has(data.bullJobId)) {
            const error = new Error('unique Bull job association');
            error.code = 'P2002';
            throw error;
          }
          currentFixture.jobAssociations.set(
            data.bullJobId,
            data.crawlResultId
          );
          return data;
        },
      },
      brokenLink: prisma.brokenLink,
      website: {
        update: async ({ data }) => {
          currentFixture.websiteStatsUpdateCount += 1;
          Object.assign(currentFixture.website, data);
          return currentFixture.website;
        },
      },
    };
    try {
      return await callback(transaction);
    } catch (error) {
      Object.assign(currentFixture, snapshot);
      throw error;
    }
  },
};
const executionSlotFixture = {
  releases: 0,
  cancelReason: null,
  leaseLost: false,
  onLeaseLost: null,
};
const crawlQueue = new EventEmitter();
const outboundRequests = [];

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (parent?.filename === workerPath) {
    if (request === '../services/queue') {
      return {
        crawlQueue,
        acquireCrawlExecutionSlot: async (_userId, _signal, onLeaseLost) => {
          executionSlotFixture.onLeaseLost = onLeaseLost;
          return {
            get leaseLost() {
              return executionSlotFixture.leaseLost;
            },
            release: async () => {
              executionSlotFixture.releases += 1;
            },
          };
        },
        watchCrawlCancellation: async (jobId, controller) => {
          const timer = executionSlotFixture.cancelReason
            ? setTimeout(() => {
                controller.abort(
                  new CrawlCancellationError(executionSlotFixture.cancelReason)
                );
              }, 5)
            : null;
          return async () => clearTimeout(timer);
        },
        clearCrawlCancellation: async () => {},
      };
    }
    if (request === '../lib/prisma') return prisma;
    if (request === '../services/crawler') return class {};
    if (request === '../services/email') {
      return {
        sendCrawlNotification: async (...args) => {
          currentFixture.emailNotifications.push({
            args,
            status: currentFixture.result.status,
            brokenLinkCount: currentFixture.brokenLinks.length,
          });
          if (currentFixture.failEmailNotifications > 0) {
            currentFixture.failEmailNotifications -= 1;
            throw new Error('email delivery failed');
          }
        },
      };
    }
    if (request === '../../config/config') {
      return { crawler: { userAgent: 'retry-test-agent' } };
    }
    if (request === '../utils/errorType') {
      return { toPrismaErrorType: (errorType) => errorType };
    }
    if (request === '../services/realtime') {
      return {
        publishCrawlEvent: async (event) => {
          currentFixture?.events.push({
            ...event,
            storedStatus: currentFixture.result?.status,
            persistedBrokenLinkCount: currentFixture.brokenLinks.length,
          });
          return true;
        },
      };
    }
    if (request === '../services/outboundUrlPolicy') {
      return {
        requestPublicUrl: async (url, options) => {
          outboundRequests.push({ url, options });
          return { status: 200 };
        },
      };
    }
  }
  return originalLoad.call(this, request, parent, isMain);
};
const CrawlProcessor = require(workerPath);
Module._load = originalLoad;

const WEBSITE_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const CRAWL_ID = '33333333-3333-4333-8333-333333333333';
const JOB_ID = 'crawl-retry-test';

function job(crawlResultId = null) {
  return {
    id: JOB_ID,
    data: {
      websiteId: WEBSITE_ID,
      userId: USER_ID,
      crawlDepth: 1,
      scheduledBy: 'manual',
      ...(crawlResultId ? { crawlResultId } : {}),
    },
    progress() {},
  };
}

function successfulCrawlData() {
  const startTime = new Date();
  const endTime = new Date(startTime.getTime() + 25);
  return {
    startTime,
    endTime,
    totalLinksFound: 0,
    totalLinksChecked: 0,
    brokenLinksFound: 0,
    redirectsFound: 0,
    timeoutsFound: 0,
    averageResponseTime: 0,
    errors: [],
    brokenLinks: [],
  };
}

function brokenLink(url = 'https://broken.example/page') {
  return {
    url,
    sourceUrl: 'https://example.invalid/source',
    linkText: 'broken link',
    statusCode: 404,
    errorType: '404_not_found',
    errorMessage: 'Not found',
    responseTime: 10,
    redirectChain: [],
  };
}

async function withAtomicAcquisitionFixture(t, initialResults = []) {
  const originalTransaction = prisma.$transaction;
  const originalJobResult = prisma.crawlJobResult;
  const associations = new Map();
  const results = new Map(initialResults.map((result) => [result.id, result]));
  let nextId = 0;
  let associationAttempts = 0;
  let releaseAssociationBarrier;
  const associationBarrier = new Promise((resolve) => {
    releaseAssociationBarrier = resolve;
  });
  const associationAttemptBarrierEnabled = initialResults.length === 0;

  const findAssociation = async ({ where, include }) => {
    const crawlResultId = associations.get(where.bullJobId);
    if (!crawlResultId) return null;
    const association = { bullJobId: where.bullJobId, crawlResultId };
    if (include?.crawlResult)
      association.crawlResult = results.get(crawlResultId);
    return association;
  };
  prisma.crawlJobResult = { findUnique: findAssociation };
  prisma.$transaction = async (callback) => {
    let createdResultId;
    try {
      return await callback({
        crawlJobResult: {
          findUnique: findAssociation,
          create: async ({ data }) => {
            if (associationAttemptBarrierEnabled) {
              associationAttempts += 1;
              if (associationAttempts === 2) releaseAssociationBarrier();
              await associationBarrier;
            }
            if (associations.has(data.bullJobId)) {
              const error = new Error('Bull job association unique constraint');
              error.code = 'P2002';
              throw error;
            }
            associations.set(data.bullJobId, data.crawlResultId);
            return data;
          },
        },
        crawlResult: {
          create: async ({ data }) => {
            const result = { id: `result-${++nextId}`, ...data };
            createdResultId = result.id;
            results.set(result.id, result);
            return result;
          },
          findUnique: async ({ where }) => results.get(where.id) || null,
          update: async ({ where, data }) => {
            const result = { ...results.get(where.id), ...data };
            results.set(where.id, result);
            return result;
          },
        },
      });
    } catch (error) {
      if (
        createdResultId &&
        ![...associations.values()].includes(createdResultId)
      ) {
        results.delete(createdResultId);
      }
      throw error;
    }
  };

  t.after(() => {
    prisma.$transaction = originalTransaction;
    prisma.crawlJobResult = originalJobResult;
  });
  return { associations, results };
}

function setupFixture(
  t,
  initialResult,
  crawlWebsite,
  { mockTimers = true } = {}
) {
  executionSlotFixture.leaseLost = false;
  executionSlotFixture.onLeaseLost = null;
  const website = {
    id: WEBSITE_ID,
    userId: USER_ID,
    url: 'https://example.invalid',
    isActive: true,
    crawlFrequency: null,
    notificationEmail: null,
    webhookUrl: null,
    totalLinks: 23,
    brokenLinks: 7,
    healthScore: 69.57,
  };

  currentFixture = {
    result: initialResult,
    jobAssociations: new Map(),
    createCount: 0,
    websiteStatsUpdateCount: 0,
    updates: [],
    events: [],
    brokenLinks: [],
    failBrokenLinkWrites: 0,
    failTerminalUpdates: 0,
    failEmailNotifications: 0,
    emailNotifications: [],
    webhookNotifications: [],
    website,
  };
  if (mockTimers) t.mock.method(global, 'setTimeout', () => ({ unref() {} }));

  const processor = new CrawlProcessor();
  processor.crawler = { crawlWebsite };
  processor.sendWebhookNotification = async (...args) => {
    currentFixture.webhookNotifications.push({
      args,
      status: currentFixture.result.status,
      brokenLinkCount: currentFixture.brokenLinks.length,
    });
    outboundRequests.push({
      url: args[0].webhookUrl,
      options: { method: 'post' },
    });
  };

  return {
    processor,
    getResult: () => currentFixture.result,
    getCreateCount: () => currentFixture.createCount,
    getWebsiteStatsUpdateCount: () => currentFixture.websiteStatsUpdateCount,
    events: currentFixture.events,
    getBrokenLinks: () => currentFixture.brokenLinks,
    emailNotifications: currentFixture.emailNotifications,
    webhookNotifications: currentFixture.webhookNotifications,
    get website() {
      return currentFixture.website;
    },
    updates: currentFixture.updates,
  };
}

test('retries a failed crawl result by executing the crawl again', async (t) => {
  let crawlCount = 0;
  const fixture = setupFixture(t, null, async () => {
    crawlCount += 1;
    if (crawlCount === 1) throw new Error('temporary crawler failure');
    return successfulCrawlData();
  });

  await assert.rejects(
    fixture.processor.processCrawlJob(job()),
    /temporary crawler failure/
  );
  assert.equal(fixture.getResult().status, 'failed');

  const retryResult = await fixture.processor.processCrawlJob(job());

  assert.equal(crawlCount, 2);
  assert.equal(fixture.getCreateCount(), 1);
  assert.equal(fixture.getResult().status, 'completed');
  assert.equal(fixture.getResult().id, CRAWL_ID);
  assert.equal(fixture.updates[1].status, 'running');
  assert.equal(fixture.updates[1].completedAt, null);
  assert.equal(fixture.updates[1].errorMessage, null);
  assert.equal(retryResult.crawlResultId, CRAWL_ID);
});

test('does not repeat a crawl after its result has completed', async (t) => {
  let crawlCount = 0;
  const fixture = setupFixture(t, null, async () => {
    crawlCount += 1;
    return successfulCrawlData();
  });

  const firstResult = await fixture.processor.processCrawlJob(job());
  const secondResult = await fixture.processor.processCrawlJob(job());

  assert.equal(crawlCount, 1);
  assert.equal(fixture.getCreateCount(), 1);
  assert.equal(fixture.getResult().status, 'completed');
  assert.equal(firstResult.crawlResultId, CRAWL_ID);
  assert.equal(secondResult.crawlResultId, CRAWL_ID);
  assert.match(secondResult.message, /already exists/);
});

test('explicit retry resumes the failed crawl-result ID instead of creating another row', async (t) => {
  const failedResult = {
    id: CRAWL_ID,
    websiteId: WEBSITE_ID,
    userId: USER_ID,
    status: 'failed',
    summary: { jobId: 'earlier-attempt' },
  };
  const fixture = setupFixture(t, failedResult, async () =>
    successfulCrawlData()
  );

  const result = await fixture.processor.processCrawlJob(job(CRAWL_ID));

  assert.equal(result.crawlResultId, CRAWL_ID);
  assert.equal(fixture.getCreateCount(), 0);
  assert.equal(fixture.getResult().id, CRAWL_ID);
  assert.equal(fixture.getResult().status, 'completed');
});

test('concurrent deliveries of one Bull job acquire exactly one crawl-result row', async (t) => {
  const database = await withAtomicAcquisitionFixture(t);
  const processor = new CrawlProcessor();
  const website = { id: WEBSITE_ID };
  const input = {
    userId: USER_ID,
    crawlDepth: 1,
    scheduledBy: 'manual',
    retryCrawlResultId: null,
  };

  const [first, second] = await Promise.all([
    processor.acquireCrawlResult({ id: 'bull-job-same' }, website, input),
    processor.acquireCrawlResult({ id: 'bull-job-same' }, website, input),
  ]);

  assert.equal(first.id, second.id);
  assert.equal(database.results.size, 1);
  assert.equal(database.associations.size, 1);
  assert.equal(database.associations.get('bull-job-same'), first.id);
});

test('different Bull job IDs receive distinct crawl-result associations', async (t) => {
  const database = await withAtomicAcquisitionFixture(t, [
    {
      id: 'legacy-result',
      websiteId: WEBSITE_ID,
      userId: USER_ID,
      status: 'failed',
      summary: {},
    },
  ]);
  const processor = new CrawlProcessor();
  const website = { id: WEBSITE_ID };
  const first = await processor.acquireCrawlResult(
    { id: 'bull-job-one' },
    website,
    { userId: USER_ID, crawlDepth: 1, scheduledBy: 'manual' }
  );
  const second = await processor.acquireCrawlResult(
    { id: 'bull-job-two' },
    website,
    { userId: USER_ID, crawlDepth: 1, scheduledBy: 'manual' }
  );

  assert.notEqual(first.id, second.id);
  assert.equal(database.associations.get('bull-job-one'), first.id);
  assert.equal(database.associations.get('bull-job-two'), second.id);
});

test('explicit Bull retry maps its new job ID to the existing crawl-result ID', async (t) => {
  const existing = {
    id: 'retry-result',
    websiteId: WEBSITE_ID,
    userId: USER_ID,
    status: 'failed',
    summary: { jobId: 'original-bull-job' },
  };
  const database = await withAtomicAcquisitionFixture(t, [existing]);
  const processor = new CrawlProcessor();
  const result = await processor.acquireCrawlResult(
    { id: 'explicit-retry-bull-job' },
    { id: WEBSITE_ID },
    {
      userId: USER_ID,
      crawlDepth: 2,
      scheduledBy: 'retry',
      retryCrawlResultId: existing.id,
    }
  );

  assert.equal(result.id, existing.id);
  assert.equal(
    database.associations.get('explicit-retry-bull-job'),
    existing.id
  );
});

test('releases per-user execution slot after worker success or failure', async () => {
  executionSlotFixture.releases = 0;
  const processor = new CrawlProcessor();
  processor.processCrawlJob = async () => 'success';

  assert.equal(await processor.processWithUserExecutionSlot(job()), 'success');
  assert.equal(executionSlotFixture.releases, 1);

  processor.processCrawlJob = async () => {
    throw new Error('worker failed');
  };
  await assert.rejects(
    processor.processWithUserExecutionSlot(job()),
    /worker failed/
  );
  assert.equal(executionSlotFixture.releases, 2);
});

test('lease loss aborts active crawling, prevents completion persistence, and remains retryable', async (t) => {
  executionSlotFixture.releases = 0;
  executionSlotFixture.leaseLost = false;
  executionSlotFixture.onLeaseLost = null;
  let observedSignal;
  let requestsStarted = 0;
  let jobDiscarded = false;
  const fixture = setupFixture(
    t,
    null,
    async (url, { signal }) => {
      observedSignal = signal;
      requestsStarted += 1;
      await new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        });
      });
      throw new Error('unreachable after lease loss');
    },
    { mockTimers: false }
  );
  const crawlJob = {
    ...job(),
    discard() {
      jobDiscarded = true;
    },
  };

  const running = fixture.processor.processWithUserExecutionSlot(crawlJob);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requestsStarted, 1);
  assert.ok(executionSlotFixture.onLeaseLost);

  executionSlotFixture.leaseLost = true;
  executionSlotFixture.onLeaseLost(new Error('redis lease renewal failed'));
  const outcome = await running;

  assert.equal(observedSignal.aborted, true);
  assert.equal(observedSignal.reason.reason, 'lease_lost');
  assert.equal(outcome.success, false);
  assert.equal(outcome.leaseLost, true);
  assert.equal(outcome.terminationReason, 'lease_lost');
  assert.equal(jobDiscarded, false);
  assert.equal(executionSlotFixture.releases, 1);
  assert.equal(fixture.getResult().status, 'running');
  assert.equal(fixture.getWebsiteStatsUpdateCount(), 0);
  assert.equal(
    fixture.events.some((event) => event.status === 'completed'),
    false
  );

  fixture.processor.processWithUserExecutionSlot = async () => outcome;
  await assert.rejects(
    fixture.processor.processQueuedCrawl(crawlJob),
    (error) =>
      error instanceof CrawlLeaseLostError && error.code === 'CRAWL_LEASE_LOST'
  );
  assert.equal(requestsStarted, 1);
});

test('persists budget-limited crawl as partial instead of completed', async (t) => {
  const fixture = setupFixture(t, null, async () => ({
    ...successfulCrawlData(),
    totalLinksFound: 20,
    totalLinksChecked: 4,
    budget: {
      maxPages: 2,
      maxNetworkRequests: 5,
      pagesProcessed: 2,
      networkRequests: 5,
      terminationReason: 'max_network_requests_reached',
    },
    terminationReason: 'max_network_requests_reached',
  }));

  const result = await fixture.processor.processCrawlJob(job());

  assert.equal(fixture.getResult().status, 'failed');
  assert.match(fixture.getResult().errorMessage, /network-request limit/i);
  assert.equal(
    fixture.getResult().summary.terminationReason,
    'max_network_requests_reached'
  );
  assert.equal(fixture.getResult().summary.budget.networkRequests, 5);
  assert.equal(result.success, false);
  assert.equal(result.terminationReason, 'max_network_requests_reached');
  assert.equal(fixture.getWebsiteStatsUpdateCount(), 0);
  assert.equal(fixture.website.totalLinks, 23);
  assert.equal(fixture.website.brokenLinks, 7);
  assert.equal(fixture.website.healthScore, 69.57);
});

test('broken-link persistence failure prevents completion and preserves website health', async (t) => {
  const fixture = setupFixture(t, null, async () => ({
    ...successfulCrawlData(),
    brokenLinksFound: 1,
    brokenLinks: [brokenLink()],
  }));
  currentFixture.failBrokenLinkWrites = 1;

  await assert.rejects(
    fixture.processor.processCrawlJob(job()),
    /broken-link persistence failed/
  );

  assert.equal(fixture.getResult().status, 'failed');
  assert.equal(fixture.getBrokenLinks().length, 0);
  assert.equal(fixture.website.totalLinks, 23);
  assert.equal(fixture.website.brokenLinks, 7);
  assert.equal(fixture.website.healthScore, 69.57);
  assert.equal(
    fixture.events.some((event) => event.status === 'completed'),
    false
  );
});

test('retries a partially written broken-link batch using the same result without duplicates', async (t) => {
  let crawlCount = 0;
  const first = brokenLink();
  const second = brokenLink('https://broken.example/other');
  const fixture = setupFixture(t, null, async () => {
    crawlCount += 1;
    return {
      ...successfulCrawlData(),
      brokenLinksFound: 2,
      brokenLinks: [first, second, first],
    };
  });
  currentFixture.failBrokenLinkWrites = 1;

  await assert.rejects(
    fixture.processor.processCrawlJob(job()),
    /persistence failed/
  );
  assert.equal(fixture.getResult().status, 'failed');
  assert.equal(fixture.getBrokenLinks().length, 0);

  await fixture.processor.processCrawlJob(job());

  assert.equal(crawlCount, 2);
  assert.equal(fixture.getResult().id, CRAWL_ID);
  assert.equal(fixture.getResult().status, 'completed');
  assert.equal(fixture.getBrokenLinks().length, 2);
  assert.equal(
    new Set(
      fixture.getBrokenLinks().map((link) => `${link.url}|${link.sourceUrl}`)
    ).size,
    2
  );
});

test('terminal status failure rolls back records and health before retry', async (t) => {
  const fixture = setupFixture(t, null, async () => ({
    ...successfulCrawlData(),
    totalLinksChecked: 10,
    brokenLinksFound: 1,
    brokenLinks: [brokenLink()],
  }));
  fixture.website.notificationEmail = 'alerts@example.invalid';
  fixture.website.webhookUrl = 'https://hooks.example.invalid/crawl';
  currentFixture.failTerminalUpdates = 1;

  await assert.rejects(
    fixture.processor.processCrawlJob(job()),
    /terminal status persistence failed/
  );
  assert.equal(fixture.getResult().status, 'failed');
  assert.equal(fixture.getBrokenLinks().length, 0);
  assert.equal(fixture.website.totalLinks, 23);
  assert.equal(fixture.website.brokenLinks, 7);
  assert.equal(fixture.emailNotifications.length, 0);
  assert.equal(fixture.webhookNotifications.length, 0);

  await fixture.processor.processCrawlJob(job());
  assert.equal(fixture.getResult().status, 'completed');
  assert.equal(fixture.getBrokenLinks().length, 1);
  assert.equal(fixture.website.totalLinks, 10);
  assert.equal(fixture.website.brokenLinks, 1);
  assert.equal(fixture.emailNotifications.length, 1);
  assert.equal(fixture.webhookNotifications.length, 1);
});

test('completion side effects observe committed state and are not resent by a worker retry', async (t) => {
  outboundRequests.length = 0;
  const fixture = setupFixture(t, null, async () => ({
    ...successfulCrawlData(),
    brokenLinksFound: 1,
    brokenLinks: [brokenLink()],
  }));
  fixture.website.notificationEmail = 'alerts@example.invalid';
  fixture.website.webhookUrl = 'https://hooks.example.invalid/crawl';
  currentFixture.failEmailNotifications = 1;

  await fixture.processor.processCrawlJob(job());
  const completedEvent = fixture.events.find(
    (event) => event.status === 'completed'
  );
  assert.equal(completedEvent.storedStatus, 'completed');
  assert.equal(completedEvent.persistedBrokenLinkCount, 1);
  assert.equal(fixture.emailNotifications.length, 1);
  assert.equal(fixture.emailNotifications[0].status, 'completed');
  assert.equal(fixture.emailNotifications[0].brokenLinkCount, 1);
  assert.equal(fixture.webhookNotifications.length, 1);
  assert.equal(fixture.webhookNotifications[0].status, 'completed');
  assert.equal(outboundRequests.length, 1);
  assert.equal(outboundRequests[0].url, fixture.website.webhookUrl);
  assert.equal(outboundRequests[0].options.method, 'post');

  await fixture.processor.processCrawlJob(job());
  assert.equal(fixture.emailNotifications.length, 1);
  assert.equal(fixture.webhookNotifications.length, 1);
});

test('timeout aborts the crawler, persists timeout status, discards retries, and releases its execution slot', async (t) => {
  executionSlotFixture.releases = 0;
  executionSlotFixture.cancelReason = null;
  let crawlSignal;
  let jobDiscarded = false;
  const fixture = setupFixture(
    t,
    null,
    async (url, { signal }) => {
      crawlSignal = signal;
      return new Promise((resolve) => {
        signal.addEventListener(
          'abort',
          () => {
            setTimeout(() => resolve(successfulCrawlData()), 20);
          },
          { once: true }
        );
      });
    },
    { mockTimers: false }
  );
  fixture.processor.crawlTimeoutMs = 5;
  const crawlJob = {
    ...job(),
    discard() {
      jobDiscarded = true;
    },
  };

  const result = await fixture.processor.processWithUserExecutionSlot(crawlJob);

  assert.equal(crawlSignal.aborted, true);
  assert.equal(fixture.getResult().status, 'failed');
  assert.equal(fixture.getResult().summary.terminationReason, 'timeout');
  assert.match(fixture.getResult().errorMessage, /timed out/i);
  assert.equal(jobDiscarded, true);
  assert.equal(result.terminationReason, 'timeout');
  assert.equal(executionSlotFixture.releases, 1);
  assert.equal(fixture.website.totalLinks, 23);
  assert.equal(fixture.website.brokenLinks, 7);
  assert.equal(fixture.website.healthScore, 69.57);
  assert.equal(
    fixture.events.some((event) => event.status === 'completed'),
    false
  );
  assert.equal(
    fixture.events.some((event) => event.status === 'failed'),
    true
  );
});

test('explicit cancellation aborts crawl and persists cancelled terminal state', async (t) => {
  executionSlotFixture.cancelReason = 'cancelled';
  const fixture = setupFixture(
    t,
    null,
    async (url, { signal }) =>
      new Promise((resolve) => {
        signal.addEventListener('abort', () => resolve(successfulCrawlData()), {
          once: true,
        });
      }),
    { mockTimers: false }
  );
  fixture.processor.crawlTimeoutMs = 1000;

  const result = await fixture.processor.processWithUserExecutionSlot(job());

  assert.equal(fixture.getResult().status, 'failed');
  assert.equal(fixture.getResult().summary.terminationReason, 'cancelled');
  assert.equal(result.terminationReason, 'cancelled');
  assert.equal(executionSlotFixture.releases, 2);
  assert.equal(fixture.website.totalLinks, 23);
  assert.equal(fixture.website.brokenLinks, 7);
  assert.equal(fixture.website.healthScore, 69.57);
  assert.equal(
    fixture.events.some((event) => event.status === 'completed'),
    false
  );
  executionSlotFixture.cancelReason = null;
});

test('late crawler resolution cannot overwrite a cancellation terminal result', async (t) => {
  executionSlotFixture.cancelReason = 'cancelled';
  let resolveLateCrawl;
  let crawlSignal;
  let signalAborted;
  const aborted = new Promise((resolve) => {
    signalAborted = resolve;
  });
  const fixture = setupFixture(
    t,
    null,
    async (url, { signal }) => {
      crawlSignal = signal;
      signal.addEventListener('abort', signalAborted, { once: true });
      return new Promise((resolve) => {
        resolveLateCrawl = resolve;
      });
    },
    { mockTimers: false }
  );
  fixture.processor.crawlTimeoutMs = 1000;
  const running = fixture.processor.processWithUserExecutionSlot(job());
  while (!resolveLateCrawl) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  await aborted;
  assert.equal(crawlSignal.aborted, true);
  resolveLateCrawl(successfulCrawlData());
  const cancellationResult = await running;
  assert.equal(cancellationResult.terminationReason, 'cancelled');
  assert.equal(fixture.getResult().status, 'failed');

  assert.equal(fixture.getResult().status, 'failed');
  assert.equal(
    fixture.updates.some((update) => update.status === 'completed'),
    false
  );
  executionSlotFixture.cancelReason = null;
});

test('queued timeout is discarded and reported as terminal worker failure', async () => {
  const processor = new CrawlProcessor();
  processor.processWithUserExecutionSlot = async () => ({
    success: false,
    terminationReason: 'timeout',
    errorMessage: 'Crawl timed out.',
  });
  let discarded = false;
  const crawlJob = {
    discard() {
      discarded = true;
    },
  };

  await assert.rejects(
    processor.processQueuedCrawl(crawlJob),
    (error) => error.code === 'CRAWL_CANCELLED' && error.reason === 'timeout'
  );
  assert.equal(discarded, true);
});
