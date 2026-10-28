const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const Module = require('node:module');
const test = require('node:test');

const queuePath = require.resolve('../src/services/queue');
const redisValues = new Map();
let fakeQueues;
let queueAddError = null;
let fakeEvalOverride = null;
fakeQueues = [];

class FakeRedis {
  async get(key) {
    return redisValues.get(key) ?? null;
  }

  async del(key) {
    return redisValues.delete(key) ? 1 : 0;
  }

  async set(key, value, ...options) {
    if (options.includes('NX') && redisValues.has(key)) return null;
    redisValues.set(key, value);
    return 'OK';
  }

  async eval(script, keyCount, key, token, ttl) {
    if (fakeEvalOverride)
      return fakeEvalOverride(script, keyCount, key, token, ttl);
    if (redisValues.get(key) !== token) return 0;
    if (script.includes('pexpire')) return 1;
    if (script.includes("redis.call('del'")) {
      redisValues.delete(key);
      return 1;
    }
    return 0;
  }
}

const fakeRedis = new FakeRedis();

class FakeBull extends EventEmitter {
  constructor(name) {
    super();
    this.name = name;
    this.jobs = [];
    this.client = fakeRedis;
    fakeQueues.push(this);
  }

  toKey(key) {
    return `${this.name}:${key}`;
  }

  async getJobs(states) {
    return this.jobs.filter((job) => states.includes(job.state));
  }

  async getJob(jobId) {
    return this.jobs.find((job) => job.id === jobId) ?? null;
  }

  async add(name, data, options = {}) {
    if (queueAddError) throw queueAddError;
    const job = {
      id: options.jobId || `job-${this.jobs.length + 1}`,
      name,
      data,
      opts: options,
      state: 'waiting',
      progress() {},
      async remove() {
        const index = this.queue.jobs.indexOf(this);
        if (index !== -1) this.queue.jobs.splice(index, 1);
      },
      async getState() {
        return this.state;
      },
      async retry() {
        this.state = 'waiting';
        this.failedReason = null;
      },
      queue: this,
    };
    this.jobs.push(job);
    return job;
  }

  async getWaiting() {
    return this.jobs.filter((job) => job.state === 'waiting');
  }

  async getActive() {
    return this.jobs.filter((job) => job.state === 'active');
  }

  async getCompleted() {
    return this.jobs.filter((job) => job.state === 'completed');
  }

  async getFailed() {
    return this.jobs.filter((job) => job.state === 'failed');
  }

  async getJobCounts() {
    return {};
  }

  async close() {}
}

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (parent?.filename === queuePath) {
    if (request === 'bull') return FakeBull;
    if (request === '../../config/config') {
      return {
        redis: {},
        crawler: {
          maxActiveJobsPerUser: 2,
          maxConcurrentPerUser: 1,
          userExecutionLeaseMs: 300,
        },
      };
    }
  }
  return originalLoad.call(this, request, parent, isMain);
};
const { QueueAdmissionError, QueueService } = require(queuePath);
Module._load = originalLoad;

function setup(t) {
  redisValues.clear();
  for (const queue of fakeQueues) queue.jobs = [];
  queueAddError = null;
  const service = new QueueService();
  t.after(async () => service.close());
  return { service, queue: service.crawlQueue };
}

const enqueue = (service, websiteId, userId = 'user-1') =>
  service.addCrawlJob(websiteId, userId, { scheduledBy: 'manual' });

test('rejects duplicate active work for one website', async (t) => {
  const { service, queue } = setup(t);
  await enqueue(service, 'website-1');

  await assert.rejects(
    enqueue(service, 'website-1'),
    (error) =>
      error instanceof QueueAdmissionError &&
      error.code === 'CRAWL_ALREADY_ACTIVE' &&
      error.statusCode === 409
  );
  assert.equal(queue.jobs.length, 1);
});

test('serializes concurrent admissions and enforces the per-user active cap', async (t) => {
  const { service, queue } = setup(t);
  const results = await Promise.allSettled([
    enqueue(service, 'website-1'),
    enqueue(service, 'website-2'),
    enqueue(service, 'website-3'),
  ]);

  assert.equal(
    results.filter((result) => result.status === 'fulfilled').length,
    2
  );
  const rejected = results.find((result) => result.status === 'rejected');
  assert.equal(rejected.reason.code, 'CRAWL_ACTIVE_LIMIT_REACHED');
  assert.equal(rejected.reason.statusCode, 429);
  assert.equal(queue.jobs.length, 2);
});

test('active-job limits are independent for different users', async (t) => {
  const { service, queue } = setup(t);
  await enqueue(service, 'user-one-site-1', 'user-1');
  await enqueue(service, 'user-one-site-2', 'user-1');
  await enqueue(service, 'user-two-site-1', 'user-2');

  assert.equal(queue.jobs.length, 3);
  assert.equal(
    queue.jobs.filter((job) => job.data.userId === 'user-2').length,
    1
  );
});

test('counts waiting, running, delayed, and paused jobs against active capacity', async (t) => {
  const { service, queue } = setup(t);
  for (const [index, state] of ['waiting', 'active'].entries()) {
    queue.jobs.push({
      id: `existing-${index}`,
      name: 'crawl-website',
      data: { websiteId: `existing-site-${index}`, userId: 'user-1' },
      state,
    });
  }

  await assert.rejects(enqueue(service, 'new-website'), {
    code: 'CRAWL_ACTIVE_LIMIT_REACHED',
  });

  queue.jobs[0].state = 'delayed';
  queue.jobs[1].state = 'paused';
  await assert.rejects(enqueue(service, 'new-website'), {
    code: 'CRAWL_ACTIVE_LIMIT_REACHED',
  });
});

test('allows a legitimate retry after the previous job reaches failed state', async (t) => {
  const { service, queue } = setup(t);
  const first = await enqueue(service, 'website-1');
  first.state = 'delayed';

  await assert.rejects(enqueue(service, 'website-1'), {
    code: 'CRAWL_ALREADY_ACTIVE',
  });

  first.state = 'failed';
  const retry = await enqueue(service, 'website-1');
  assert.notEqual(retry.id, first.id);
  assert.equal(queue.jobs.length, 2);
});

test('explicit Bull retry reuses the failed job and respects active capacity', async (t) => {
  const { service, queue } = setup(t);
  const failed = await enqueue(service, 'website-1');
  failed.state = 'failed';
  failed.failedReason = 'previous attempt failed';

  assert.equal(await service.retryJob('crawl', failed.id), true);
  assert.equal(queue.jobs.length, 1);
  assert.equal(queue.jobs[0].id, failed.id);
  assert.equal(queue.jobs[0].state, 'waiting');
});

test('rejects explicit Bull retry when other active jobs fill the user cap', async (t) => {
  const { service } = setup(t);
  const failed = await enqueue(service, 'website-1');
  failed.state = 'failed';
  failed.failedReason = 'previous attempt failed';
  await enqueue(service, 'website-2');
  await enqueue(service, 'website-3');

  await assert.rejects(service.retryJob('crawl', failed.id), {
    code: 'CRAWL_ACTIVE_LIMIT_REACHED',
  });
  assert.equal(failed.state, 'failed');
});

test('terminal and removed jobs no longer consume active capacity', async (t) => {
  const { service, queue } = setup(t);
  const first = await enqueue(service, 'website-1');
  const second = await enqueue(service, 'website-2');

  first.state = 'completed';
  second.state = 'failed';
  await enqueue(service, 'website-3');
  await enqueue(service, 'website-4');

  await queue.jobs[2].remove();
  await enqueue(service, 'website-3');
  assert.equal(queue.jobs.filter((job) => job.state === 'waiting').length, 2);
});

test('limits simultaneous crawl execution per user across service instances', async (t) => {
  const { service } = setup(t);
  const secondService = new QueueService();
  t.after(async () => secondService.close());

  const firstSlot = await service.acquireCrawlExecutionSlot('user-1');
  const otherUserSlot = await secondService.acquireCrawlExecutionSlot('user-2');
  let secondAcquired = false;
  const secondSlotPromise = secondService
    .acquireCrawlExecutionSlot('user-1')
    .then((slot) => {
      secondAcquired = true;
      return slot;
    });

  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(secondAcquired, false);

  await firstSlot.release();
  const secondSlot = await secondSlotPromise;
  assert.equal(secondAcquired, true);
  await otherUserSlot.release();
  await secondSlot.release();
});

test('execution lease renewal failure immediately notifies the owning worker once', async (t) => {
  const { service, queue } = setup(t);
  const originalSetInterval = global.setInterval;
  let renewCallback;
  global.setInterval = (callback) => {
    renewCallback = callback;
    return { fakeTimer: true };
  };
  t.after(() => {
    global.setInterval = originalSetInterval;
  });

  const lostErrors = [];
  const lease = await service.acquireCrawlExecutionSlot(
    'user-lease-loss',
    null,
    (error) => lostErrors.push(error)
  );
  const lockKey = queue.toKey('crawl-user-slot:user-lease-loss:0');
  fakeEvalOverride = async () => 0;
  t.after(() => {
    fakeEvalOverride = null;
  });

  renewCallback();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(lease.leaseLost, true);
  assert.equal(lostErrors.length, 1);
  assert.match(lostErrors[0].message, /no longer owned/i);
  await lease.release();
  assert.equal(redisValues.has(lockKey), true);
});

test('execution lease release cannot delete a replacement worker token', async (t) => {
  const { service, queue } = setup(t);
  const originalSetInterval = global.setInterval;
  global.setInterval = () => ({ fakeTimer: true });
  t.after(() => {
    global.setInterval = originalSetInterval;
  });

  const lease = await service.acquireCrawlExecutionSlot('user-replaced-lease');
  const lockKey = queue.toKey('crawl-user-slot:user-replaced-lease:0');
  redisValues.set(lockKey, 'replacement-worker-token');

  await lease.release();

  assert.equal(redisValues.get(lockKey), 'replacement-worker-token');
});

test('failed Bull enqueue leaves no phantom active job capacity', async (t) => {
  const { service, queue } = setup(t);
  queueAddError = new Error('redis add failed');
  await assert.rejects(enqueue(service, 'website-1'), /redis add failed/);

  queueAddError = null;
  await enqueue(service, 'website-1');
  assert.equal(queue.jobs.length, 1);
});

test('canceling an active crawl writes the shared cancellation signal', async (t) => {
  const { service, queue } = setup(t);
  const active = await enqueue(service, 'website-1');
  active.state = 'active';

  assert.equal(await service.cancelJob('crawl', active.id), true);
  assert.equal(
    redisValues.get(queue.toKey(`crawl-cancel:${active.id}`)),
    'cancelled'
  );
  assert.equal(queue.jobs.includes(active), true);
});

test('worker cancellation watcher observes and clears the shared Redis signal', async (t) => {
  const { service, queue } = setup(t);
  const controller = new AbortController();
  await service.requestCrawlCancellation('active-job-id');
  const stopWatching = await service.watchCrawlCancellation(
    'active-job-id',
    controller,
    5
  );

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(controller.signal.aborted, true);
  assert.equal(controller.signal.reason.reason, 'cancelled');

  await stopWatching();
  await service.clearCrawlCancellation('active-job-id');
  assert.equal(
    await queue.client.get(queue.toKey('crawl-cancel:active-job-id')),
    null
  );
});

test('canceling a waiting crawl removes it without leaving active capacity', async (t) => {
  const { service, queue } = setup(t);
  const waiting = await enqueue(service, 'website-1');

  assert.equal(await service.cancelJob('crawl', waiting.id), true);
  assert.equal(queue.jobs.includes(waiting), false);
  await enqueue(service, 'website-1');
  assert.equal(queue.jobs.length, 1);
});
