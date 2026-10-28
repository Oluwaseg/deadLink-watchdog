const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const test = require('node:test');
const prisma = require('../src/lib/prisma');
const CrawlProcessor = require('../src/workers/crawlProcessor');
const { crawlQueue, notificationQueue } = require('../src/services/queue');

const userId = randomUUID();
const websiteId = randomUUID();
const processor = new CrawlProcessor();
const website = { id: websiteId };
const acquisitionOptions = {
  userId,
  crawlDepth: 1,
  scheduledBy: 'integration-test',
};

test.before(async () => {
  assert.ok(
    process.env.TEST_DATABASE_URL,
    'TEST_DATABASE_URL must be set by the guarded runner.'
  );
  await prisma.$connect();
  await prisma.user.create({
    data: {
      id: userId,
      email: `postgres-it-${userId}@example.invalid`,
      password: 'integration-test-only',
      firstName: 'Integration',
      lastName: 'Test',
    },
  });
  await prisma.website.create({
    data: {
      id: websiteId,
      url: 'https://integration.invalid',
      name: `Postgres integration ${websiteId}`,
      userId,
    },
  });
});

test.after(async () => {
  await prisma.user.deleteMany({ where: { id: userId } });
  await Promise.all([
    crawlQueue.close(),
    notificationQueue.close(),
    prisma.$disconnect(),
  ]);
});

test('concurrent acquisition of one Bull job ID creates one row and association', async () => {
  const bullJobId = `postgres-it-same-${randomUUID()}`;
  const [first, second] = await Promise.all([
    processor.acquireCrawlResult(
      { id: bullJobId },
      website,
      acquisitionOptions
    ),
    processor.acquireCrawlResult(
      { id: bullJobId },
      website,
      acquisitionOptions
    ),
  ]);

  assert.equal(first.id, second.id);
  assert.equal(await prisma.crawlResult.count({ where: { id: first.id } }), 1);
  assert.equal(await prisma.crawlJobResult.count({ where: { bullJobId } }), 1);
});

test('different Bull job IDs acquire distinct results', async () => {
  const first = await processor.acquireCrawlResult(
    { id: `postgres-it-one-${randomUUID()}` },
    website,
    acquisitionOptions
  );
  const second = await processor.acquireCrawlResult(
    { id: `postgres-it-two-${randomUUID()}` },
    website,
    acquisitionOptions
  );
  assert.notEqual(first.id, second.id);
});

test('explicit retry maps a new Bull job ID to the existing CrawlResult', async () => {
  const countBefore = await prisma.crawlResult.count({ where: { userId } });
  const original = await prisma.crawlResult.create({
    data: {
      websiteId,
      userId,
      status: 'failed',
      summary: { jobId: `postgres-it-old-${randomUUID()}` },
    },
  });
  const retried = await processor.acquireCrawlResult(
    { id: `postgres-it-retry-${randomUUID()}` },
    website,
    { ...acquisitionOptions, retryCrawlResultId: original.id }
  );
  assert.equal(retried.id, original.id);
  assert.equal(
    await prisma.crawlResult.count({ where: { userId } }),
    countBefore + 1
  );
});

test('failed transaction leaves neither result nor Bull-job association', async () => {
  const marker = `postgres-it-rollback-${randomUUID()}`;
  await assert.rejects(
    prisma.$transaction(async (transaction) => {
      const result = await transaction.crawlResult.create({
        data: {
          websiteId,
          userId,
          status: 'running',
          summary: { jobId: marker },
        },
      });
      await transaction.crawlJobResult.create({
        data: { bullJobId: marker, crawlResultId: result.id },
      });
      throw new Error('intentional integration rollback');
    }),
    /intentional integration rollback/
  );
  assert.equal(
    await prisma.crawlResult.count({
      where: { userId, summary: { path: ['jobId'], equals: marker } },
    }),
    0
  );
  assert.equal(
    await prisma.crawlJobResult.count({ where: { bullJobId: marker } }),
    0
  );
});
