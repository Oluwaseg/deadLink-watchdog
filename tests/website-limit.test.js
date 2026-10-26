const assert = require('node:assert/strict');
const http = require('node:http');
const Module = require('node:module');
const { once } = require('node:events');
const test = require('node:test');

const routePath = require.resolve('../src/routes/websites');
const USER_ID = '11111111-1111-4111-8111-111111111111';

let fixture;
const prisma = {
  $transaction: async (callback) => {
    let release;
    const previous = fixture.transactionTail;
    fixture.transactionTail = new Promise((resolve) => {
      release = resolve;
    });
    await previous;

    const originalRows = fixture.websites.map((website) => ({ ...website }));
    const transaction = {
      $queryRaw: async (strings) => {
        assert.match(strings.join(' '), /FOR UPDATE/i);
        return [{ id: USER_ID }];
      },
      website: {
        findFirst: async ({ where }) =>
          fixture.websites.find(
            (website) =>
              website.userId === where.userId &&
              (where.url === undefined || website.url === where.url) &&
              (where.id === undefined || website.id === where.id)
          ) ?? null,
        count: async ({ where }) =>
          fixture.websites.filter((website) => website.userId === where.userId)
            .length,
        create: async ({ data }) => {
          const website = {
            id: `website-${++fixture.nextId}`,
            isActive: true,
            ...data,
          };
          fixture.websites.push(website);
          return website;
        },
        update: async ({ where, data }) => {
          const website = fixture.websites.find(
            (entry) => entry.id === where.id
          );
          Object.assign(website, data);
          return website;
        },
      },
    };

    try {
      return await callback(transaction);
    } catch (error) {
      fixture.websites = originalRows;
      throw error;
    } finally {
      release();
    }
  },
  website: {
    findMany: async ({ where }) =>
      fixture.websites.filter((website) => {
        if (website.userId !== where.userId) return false;
        if (where.category && website.category !== where.category) return false;
        if (
          where.isActive !== undefined &&
          website.isActive !== where.isActive
        ) {
          return false;
        }
        return true;
      }),
    count: async ({ where }) =>
      fixture.websites.filter((website) => {
        if (website.userId !== where.userId) return false;
        if (where.category && website.category !== where.category) return false;
        if (
          where.isActive !== undefined &&
          website.isActive !== where.isActive
        ) {
          return false;
        }
        return true;
      }).length,
    findFirst: async ({ where }) =>
      fixture.websites.find(
        (website) => website.userId === where.userId && website.id === where.id
      ) ?? null,
    update: async ({ where, data }) => {
      const website = fixture.websites.find((entry) => entry.id === where.id);
      Object.assign(website, data);
      return website;
    },
    delete: async ({ where }) => {
      const index = fixture.websites.findIndex(
        (website) => website.id === where.id
      );
      return fixture.websites.splice(index, 1)[0];
    },
  },
  brokenLink: { deleteMany: async () => ({ count: 0 }) },
  crawlResult: { deleteMany: async () => ({ count: 0 }) },
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (parent?.filename === routePath) {
    if (request === '../lib/prisma') return prisma;
    if (request === '../services/queue') {
      return {
        QueueService: class {
          async addCrawlJob(websiteId, userId, options) {
            fixture.queuedCrawls.push({ websiteId, userId, options });
            if (fixture.queueError) throw fixture.queueError;
            return { id: `job-${websiteId}` };
          }

          async removeRecurringCrawlJob(websiteId) {
            fixture.removedRecurringJobs.push(websiteId);
          }
        },
      };
    }
    if (request === '../middleware/errorHandler') {
      return {
        asyncHandler: (handler) => (req, res, next) =>
          Promise.resolve(handler(req, res, next)).catch(next),
        AppError: class AppError extends Error {
          constructor(message, statusCode, code) {
            super(message);
            this.statusCode = statusCode;
            this.code = code;
          }
        },
      };
    }
  }
  return originalLoad.call(this, request, parent, isMain);
};
const websitesRouter = require(routePath);
Module._load = originalLoad;

function makeInitialWebsites(count, inactiveIndex = -1) {
  return Array.from({ length: count }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    userId: USER_ID,
    url: `https://existing-${index + 1}.example.com`,
    name: `Existing ${index + 1}`,
    isActive: index !== inactiveIndex,
  }));
}

async function startFixture(initialCount = 0, inactiveIndex = -1) {
  fixture = {
    websites: makeInitialWebsites(initialCount, inactiveIndex),
    nextId: initialCount,
    transactionTail: Promise.resolve(),
    queuedCrawls: [],
    removedRecurringJobs: [],
    queueError: null,
  };

  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use(
    '/api/websites',
    (req, res, next) => {
      req.user = { id: USER_ID };
      next();
    },
    websitesRouter
  );
  app.use((error, req, res, next) => {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message,
      code: error.code || 'INTERNAL_ERROR',
    });
  });

  const server = http.createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}/api/websites`;

  return {
    async close() {
      server.close();
      await once(server, 'close');
    },
    async create(url) {
      return fetch(baseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'New website', url }),
      });
    },
    async request(path = '', options = {}) {
      return fetch(`${baseUrl}${path}`, options);
    },
    async delete(id) {
      return fetch(`${baseUrl}/${id}`, { method: 'DELETE' });
    },
    get websites() {
      return fixture.websites;
    },
    get queuedCrawls() {
      return fixture.queuedCrawls;
    },
    set queueError(error) {
      fixture.queueError = error;
    },
  };
}

async function withFixture(t, count = 0, inactiveIndex = -1) {
  const instance = await startFixture(count, inactiveIndex);
  t.after(() => instance.close());
  return instance;
}

test('allows creation when a user has zero, one, or two websites', async (t) => {
  for (const initialCount of [0, 1, 2]) {
    await t.test(`allows a user with ${initialCount} websites`, async (t) => {
      const instance = await withFixture(t, initialCount);
      const response = await instance.create('https://new.example.com');

      assert.equal(response.status, 201);
      assert.equal(instance.websites.length, initialCount + 1);
      assert.equal(instance.queuedCrawls.length, 1);
    });
  }
});

test('rejects a fourth website with a stable 409 limit error', async (t) => {
  const instance = await withFixture(t, 3);
  const response = await instance.create('https://fourth.example.com');
  const payload = await response.json();

  assert.equal(response.status, 409);
  assert.equal(payload.code, 'WEBSITE_LIMIT_REACHED');
  assert.match(payload.error, /up to 3 websites/i);
  assert.equal(instance.websites.length, 3);
  assert.equal(instance.queuedCrawls.length, 0);
});

test('inactive websites count toward the limit', async (t) => {
  const instance = await withFixture(t, 3, 1);
  const response = await instance.create(
    'https://inactive-counted.example.com'
  );

  assert.equal(response.status, 409);
  assert.equal(instance.websites.length, 3);
});

test('preserves existing accounts above the limit and blocks new creation', async (t) => {
  const instance = await withFixture(t, 4);
  const originalIds = instance.websites.map((website) => website.id);
  const response = await instance.create('https://fifth.example.com');

  assert.equal(response.status, 409);
  assert.deepEqual(
    instance.websites.map((website) => website.id),
    originalIds
  );

  const listResponse = await instance.request();
  const listPayload = await listResponse.json();
  assert.equal(listResponse.status, 200);
  assert.equal(listPayload.data.pagination.total, 4);

  const websiteId = instance.websites[0].id;
  const updateResponse = await instance.request(`/${websiteId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Updated existing website',
      url: instance.websites[0].url,
    }),
  });
  assert.equal(updateResponse.status, 200);

  const crawlResponse = await instance.request(`/${websiteId}/crawl`, {
    method: 'POST',
  });
  assert.equal(crawlResponse.status, 200);
  assert.equal(instance.queuedCrawls.length, 1);

  const deleteResponse = await instance.delete(websiteId);
  assert.equal(deleteResponse.status, 200);
  assert.equal(instance.websites.length, 3);
});

test('deleting an owned website frees a slot', async (t) => {
  const instance = await withFixture(t, 3);
  const deletedWebsiteId = instance.websites[0].id;
  const deleteResponse = await instance.delete(deletedWebsiteId);
  const createResponse = await instance.create(
    'https://replacement.example.com'
  );

  assert.equal(deleteResponse.status, 200);
  assert.equal(createResponse.status, 201);
  assert.equal(instance.websites.length, 3);
});

test('duplicate URL rejection remains 409 and precedes the website limit', async (t) => {
  const instance = await withFixture(t, 2);
  const duplicateResponse = await instance.create(instance.websites[0].url);
  const duplicatePayload = await duplicateResponse.json();

  assert.equal(duplicateResponse.status, 409);
  assert.equal(duplicatePayload.code, 'WEBSITE_EXISTS');
  assert.equal(instance.websites.length, 2);

  const fullInstance = await withFixture(t, 3);
  const fullDuplicateResponse = await fullInstance.create(
    fullInstance.websites[0].url
  );
  const fullDuplicatePayload = await fullDuplicateResponse.json();
  assert.equal(fullDuplicatePayload.code, 'WEBSITE_EXISTS');
});

test('serializes concurrent creates so the user cannot exceed three websites', async (t) => {
  const instance = await withFixture(t, 2);
  const responses = await Promise.all([
    instance.create('https://concurrent-a.example.com'),
    instance.create('https://concurrent-b.example.com'),
  ]);

  assert.deepEqual(
    responses.map((response) => response.status).sort(),
    [201, 409]
  );
  assert.equal(instance.websites.length, 3);
  assert.equal(instance.queuedCrawls.length, 1);
});

test('queue failure leaves the committed website record, matching prior behavior', async (t) => {
  const instance = await withFixture(t);
  instance.queueError = new Error('queue unavailable');
  const response = await instance.create('https://queue-fails.example.com');
  const payload = await response.json();

  assert.equal(response.status, 500);
  assert.equal(payload.error, 'queue unavailable');
  assert.equal(instance.websites.length, 1);
  assert.equal(instance.queuedCrawls.length, 1);
});

test('initial crawl admission rejection removes the newly created website', async (t) => {
  const instance = await withFixture(t);
  const admissionError = new Error('Active crawl job limit reached');
  admissionError.statusCode = 429;
  admissionError.code = 'CRAWL_ACTIVE_LIMIT_REACHED';
  instance.queueError = admissionError;

  const response = await instance.create('https://not-admitted.example.com');
  const payload = await response.json();

  assert.equal(response.status, 429);
  assert.equal(payload.code, 'CRAWL_ACTIVE_LIMIT_REACHED');
  assert.equal(instance.websites.length, 0);
});

test('manual crawl admission rejection returns the stable queue error', async (t) => {
  const instance = await withFixture(t, 1);
  const admissionError = new Error(
    'You have reached the active crawl job limit.'
  );
  admissionError.statusCode = 429;
  admissionError.code = 'CRAWL_ACTIVE_LIMIT_REACHED';
  instance.queueError = admissionError;

  const response = await instance.request(`/${instance.websites[0].id}/crawl`, {
    method: 'POST',
  });
  const payload = await response.json();

  assert.equal(response.status, 429);
  assert.equal(payload.code, 'CRAWL_ACTIVE_LIMIT_REACHED');
  assert.match(payload.error, /active crawl job limit/i);
});
