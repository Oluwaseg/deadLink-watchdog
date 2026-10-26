const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');
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
  },
  brokenLink: { createMany: async () => ({ count: 0 }) },
  user: { findUnique: async () => null },
};
const executionSlotFixture = { releases: 0 };

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (parent?.filename === workerPath) {
    if (request === '../services/queue') {
      return {
        crawlQueue: {},
        acquireCrawlExecutionSlot: async () => ({
          leaseLost: false,
          release: async () => {
            executionSlotFixture.releases += 1;
          },
        }),
      };
    }
    if (request === '../lib/prisma') return prisma;
    if (request === '../services/crawler') return class {};
    if (request === '../services/email') return {};
    if (request === '../../config/config') {
      return { crawler: { userAgent: 'retry-test-agent' } };
    }
    if (request === '../utils/errorType') {
      return { toPrismaErrorType: (errorType) => errorType };
    }
    if (request === '../services/realtime') {
      return { publishCrawlEvent: async () => false };
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

function job() {
  return {
    id: JOB_ID,
    data: {
      websiteId: WEBSITE_ID,
      userId: USER_ID,
      crawlDepth: 1,
      scheduledBy: 'manual',
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

function setupFixture(t, initialResult, crawlWebsite) {
  const website = {
    id: WEBSITE_ID,
    userId: USER_ID,
    url: 'https://example.invalid',
    isActive: true,
    crawlFrequency: null,
    notificationEmail: null,
    webhookUrl: null,
  };

  currentFixture = {
    result: initialResult,
    createCount: 0,
    updates: [],
    website,
  };
  t.mock.method(global, 'setTimeout', () => ({ unref() {} }));

  const processor = new CrawlProcessor();
  processor.crawler = { crawlWebsite };
  processor.updateWebsiteStats = async () => {};

  return {
    processor,
    getResult: () => currentFixture.result,
    getCreateCount: () => currentFixture.createCount,
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
