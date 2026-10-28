const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const Module = require('node:module');
const test = require('node:test');

const workerPath = require.resolve('../src/workers/crawlProcessor');
const queue = new EventEmitter();
const processors = new Map();
const fixture = { waiting: [], active: [], paused: false, warnings: [] };
let redisPingError = null;
let startupJobsAdded = 0;

queue.client = {
  ping: (callback) =>
    callback(redisPingError, redisPingError ? undefined : 'PONG'),
};
queue.add = async () => {
  startupJobsAdded += 1;
  return { id: 'startup-test-job' };
};
queue.process = (name, concurrency, handler) => {
  processors.set(name, { concurrency, handler });
};
queue.getWaiting = async () => fixture.waiting;
queue.getActive = async () => fixture.active;
queue.getCompleted = async () => [];
queue.getFailed = async () => [];
queue.isPaused = async () => fixture.paused;
queue.resume = async () => {
  fixture.paused = false;
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (parent?.filename === workerPath) {
    if (request === '../services/queue') {
      return {
        crawlQueue: queue,
        acquireCrawlExecutionSlot: async () => ({ release: async () => {} }),
        watchCrawlCancellation: async () => async () => {},
        clearCrawlCancellation: async () => {},
      };
    }
    if (request === '../lib/prisma') return {};
    if (request === '../services/crawler') {
      return class FakeCrawler {
        async initialize() {}
        async close() {}
        async checkLink() {
          return { status: 'success' };
        }
      };
    }
    if (request === '../services/email') return {};
    if (request === '../../config/config') {
      return { crawler: { maxConcurrent: 3, userAgent: 'recovery-test' } };
    }
    if (request === '../utils/errorType')
      return { toPrismaErrorType: (value) => value };
    if (request === '../services/outboundUrlPolicy')
      return { requestPublicUrl: async () => ({ status: 200 }) };
    if (request === '../services/realtime')
      return { publishCrawlEvent: async () => true };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const CrawlProcessor = require(workerPath);
Module._load = originalLoad;

function makeWaitingJob() {
  return {
    id: 'waiting-crawl-1',
    name: 'crawl-website',
    data: { websiteId: 'site-1', userId: 'user-1' },
    state: 'waiting',
    removeCalls: 0,
    async remove() {
      this.removeCalls += 1;
      this.state = 'removed';
    },
    progress() {},
  };
}

test('health recovery observes but never executes or removes Bull-owned waiting jobs', async (t) => {
  const processor = new CrawlProcessor();
  const waitingJob = makeWaitingJob();
  fixture.waiting = [waitingJob];
  fixture.active = [];
  let duplicateExecutionCalls = 0;
  processor.processWithUserExecutionSlot = async () => {
    duplicateExecutionCalls += 1;
  };

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  t.after(() => {
    console.warn = originalWarn;
  });

  await processor.checkQueueHealth();

  assert.equal(duplicateExecutionCalls, 0);
  assert.equal(waitingJob.removeCalls, 0);
  assert.equal(waitingJob.state, 'waiting');
  assert.equal(fixture.waiting.includes(waitingJob), true);
  assert.equal(warnings.length, 0);
});

test('Bull registered handler is the only execution path and stalled events do not remove jobs', async (t) => {
  const processor = new CrawlProcessor();
  const originalSetTimeout = global.setTimeout;
  const originalSetInterval = global.setInterval;
  global.setTimeout = () => ({ unref() {} });
  global.setInterval = () => ({ unref() {} });
  t.after(() => {
    global.setTimeout = originalSetTimeout;
    global.setInterval = originalSetInterval;
  });

  await processor.start();
  const crawlHandler = processors.get('crawl-website');
  assert.ok(crawlHandler);
  assert.equal(crawlHandler.concurrency, 3);
  assert.equal(startupJobsAdded, 0);

  const job = makeWaitingJob();
  let processCalls = 0;
  processor.processQueuedCrawl = async (receivedJob) => {
    processCalls += 1;
    assert.equal(receivedJob, job);
    return { success: true };
  };
  const stalledEvents = [];
  const originalWarn = console.warn;
  console.warn = (...args) => stalledEvents.push(args.join(' '));
  t.after(() => {
    console.warn = originalWarn;
  });

  queue.emit('stalled', job);
  assert.equal(job.removeCalls, 0);
  assert.equal(
    stalledEvents.some((message) => message.includes(job.id)),
    true
  );

  await crawlHandler.handler(job);
  assert.equal(processCalls, 1);
  assert.equal(job.removeCalls, 0);
  assert.equal(job.state, 'waiting');
});

test('worker startup fails before registering processors when Redis ping fails', async () => {
  const processor = new CrawlProcessor();
  redisPingError = new Error('injected Redis unavailability');
  const processorCount = processors.size;
  try {
    await assert.rejects(processor.start(), /injected Redis unavailability/);
    assert.equal(processors.size, processorCount);
  } finally {
    redisPingError = null;
  }
});
