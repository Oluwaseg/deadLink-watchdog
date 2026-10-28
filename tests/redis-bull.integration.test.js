const assert = require('node:assert/strict');
const Bull = require('bull');
const { fork } = require('node:child_process');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const { QueueService } = require('../src/services/queue');

const bullRedis = {
  host: process.env.REDIS_HOST || 'localhost',
  port: Number(process.env.REDIS_PORT || 6379),
  password: process.env.REDIS_PASSWORD || undefined,
};

const service = new QueueService();
const cleanupQueues = new Set([service.crawlQueue, service.notificationQueue]);

const workerPath = require.resolve('../src/workers/crawlProcessor');
const workerPrisma = createWorkerPrismaFixture();
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (parent?.filename === workerPath && request === '../lib/prisma') {
    return workerPrisma;
  }
  if (parent?.filename === workerPath && request === '../services/realtime') {
    return { publishCrawlEvent: async () => true };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const CrawlProcessor = require(workerPath);
Module._load = originalLoad;

function createWorkerPrismaFixture() {
  let result;
  let association;
  let website;
  let websiteWrites;

  return {
    reset() {
      result = null;
      association = null;
      websiteWrites = 0;
      website = {
        id: '33333333-3333-4333-8333-333333333333',
        userId: '44444444-4444-4444-8444-444444444444',
        url: 'https://lease-integration.invalid',
        isActive: true,
        totalLinks: 8,
        brokenLinks: 2,
        healthScore: 75,
      };
    },
    website: {
      findUnique: async () => website,
      update: async ({ data }) => {
        websiteWrites += 1;
        Object.assign(website, data);
        return website;
      },
    },
    crawlResult: {
      create: async ({ data }) => {
        result = {
          id: '55555555-5555-4555-8555-555555555555',
          ...data,
        };
        return result;
      },
      findUnique: async () => result,
      update: async ({ data }) => Object.assign(result, data),
      updateMany: async ({ data }) => {
        Object.assign(result, data);
        return { count: 1 };
      },
    },
    crawlJobResult: {
      findUnique: async () => association,
    },
    async $transaction(callback) {
      return callback({
        crawlResult: this.crawlResult,
        crawlJobResult: {
          findUnique: this.crawlJobResult.findUnique,
          create: async ({ data }) => {
            association = data;
            return data;
          },
        },
        brokenLink: {
          deleteMany: async () => ({ count: 0 }),
          createMany: async () => ({ count: 0 }),
        },
        website: this.website,
        $queryRaw: async () => [],
      });
    },
    snapshot() {
      return {
        result: result && { ...result },
        association: association && { ...association },
        website: { ...website },
        websiteWrites,
      };
    },
  };
}

workerPrisma.reset();

test.after(async () => {
  for (const queue of cleanupQueues) {
    await queue.pause(true).catch(() => {});
    await queue.obliterate({ force: true }).catch(() => {});
    await queue.close().catch(() => {});
  }
});

test('real Redis serializes crawl admission and enforces per-user capacity', async () => {
  const jobs = await Promise.allSettled([
    service.addCrawlJob('redis-site-1', 'redis-user'),
    service.addCrawlJob('redis-site-2', 'redis-user'),
    service.addCrawlJob('redis-site-3', 'redis-user'),
  ]);
  assert.equal(jobs.filter((entry) => entry.status === 'fulfilled').length, 2);
  const rejected = jobs.find((entry) => entry.status === 'rejected');
  assert.equal(rejected.reason.code, 'CRAWL_ACTIVE_LIMIT_REACHED');
  const active = await service.crawlQueue.getJobs(['waiting', 'active']);
  assert.equal(active.length, 2);
});

test('real Bull retries a failed attempt and completes the same job', async () => {
  const queue = new Bull(`retry-${process.pid}`, {
    redis: bullRedis,
    prefix: process.env.BULL_PREFIX,
    defaultJobOptions: {
      attempts: 2,
      backoff: { type: 'fixed', delay: 50 },
    },
  });
  cleanupQueues.add(queue);
  let attempts = 0;
  queue.process('retry-check', async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('expected first-attempt failure');
    return 'retried';
  });
  const job = await queue.add('retry-check', {}, { removeOnComplete: false });
  const result = await job.finished();
  const persistedJob = await queue.getJob(job.id);
  assert.equal(result, 'retried');
  assert.equal(attempts, 2);
  assert.equal(persistedJob.attemptsMade, 1);
});

test('real Bull recovers a job stalled after its first worker closes', async () => {
  const queueName = `stalled-${process.pid}`;
  const options = {
    redis: bullRedis,
    prefix: process.env.BULL_PREFIX,
    settings: { lockDuration: 1000, stalledInterval: 500, maxStalledCount: 1 },
  };
  const queue = new Bull(queueName, options);
  const recoveryWorker = new Bull(queueName, options);
  cleanupQueues.add(queue);
  cleanupQueues.add(recoveryWorker);

  const job = await queue.add('stalled-check', {}, { removeOnComplete: false });
  const firstWorker = fork(
    path.join(__dirname, 'fixtures', 'stalled-job-worker.js'),
    [],
    {
      env: {
        ...process.env,
        TEST_BULL_QUEUE: queueName,
        TEST_BULL_PREFIX: process.env.BULL_PREFIX,
        TEST_REDIS_HOST: bullRedis.host,
        TEST_REDIS_PORT: String(bullRedis.port),
        TEST_REDIS_PASSWORD: bullRedis.password || '',
      },
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    }
  );
  const firstStarted = new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('First Bull worker did not acquire the job')),
      5000
    );
    firstWorker.once('message', (message) => {
      clearTimeout(timeout);
      if (message === 'active') resolve();
      else reject(new Error(`Unexpected child worker message: ${message}`));
    });
    firstWorker.once('error', reject);
  });
  await firstStarted;
  firstWorker.kill();
  await new Promise((resolve, reject) => {
    firstWorker.once('exit', resolve);
    firstWorker.once('error', reject);
  });

  let announceRecovery;
  const recovered = new Promise((resolve) => (announceRecovery = resolve));
  let executions = 1;
  recoveryWorker.process('stalled-check', async () => {
    executions += 1;
    announceRecovery();
    return 'recovered';
  });
  await Promise.race([
    recovered,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error('Bull did not recover the stalled job')),
        10000
      )
    ),
  ]);
  assert.equal(await job.finished(), 'recovered');
  assert.equal(executions, 2);
});

test('real Redis lease renewal failure aborts the active worker and preserves replacement token', async () => {
  const leaseMs = 60000;
  const leaseService = new QueueService();
  workerPrisma.reset();
  const processor = new CrawlProcessor();
  let observedSignal;
  processor.crawler = {
    crawlWebsite: async (_url, { signal }) => {
      observedSignal = signal;
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        });
      });
    },
  };
  const originalSetInterval = global.setInterval;
  global.setInterval = (callback) => setTimeout(callback, 100);
  const userId = '44444444-4444-4444-8444-444444444444';
  const jobId = `lease-loss-${process.pid}`;
  const renewKey = leaseService.crawlQueue.toKey(`crawl-user-slot:${userId}:0`);

  let running;
  try {
    running = processor.processWithUserExecutionSlot({
      id: jobId,
      data: {
        websiteId: '33333333-3333-4333-8333-333333333333',
        userId,
        crawlDepth: 1,
        scheduledBy: 'manual',
      },
      progress() {},
    });
    const acquisitionDeadline = Date.now() + 5000;
    let renewToken;
    while (Date.now() < acquisitionDeadline) {
      renewToken = await leaseService.crawlQueue.client.get(renewKey);
      if (renewToken && observedSignal) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(renewToken, 'worker did not acquire the Redis execution lease');
    assert.ok(observedSignal, 'crawler did not begin before the lease check');
    await leaseService.crawlQueue.client.set(
      renewKey,
      'replacement-worker-token',
      'PX',
      leaseMs
    );
    const outcome = await running;
    assert.equal(outcome.terminationReason, 'lease_lost');
    assert.equal(observedSignal.aborted, true);
    assert.equal(observedSignal.reason.reason, 'lease_lost');
    const persisted = workerPrisma.snapshot();
    assert.equal(persisted.result.status, 'running');
    assert.equal(persisted.websiteWrites, 0);
    assert.equal(persisted.website.totalLinks, 8);
    assert.equal(persisted.website.brokenLinks, 2);
    assert.equal(persisted.website.healthScore, 75);
    assert.equal(
      await leaseService.crawlQueue.client.get(renewKey),
      'replacement-worker-token'
    );
    assert.ok(renewToken);
  } finally {
    if (running) await running.catch(() => {});
    global.setInterval = originalSetInterval;
    await leaseService.crawlQueue.client.del(renewKey);
    await leaseService.close();
  }
});
