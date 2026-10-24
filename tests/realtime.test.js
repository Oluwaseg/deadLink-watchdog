const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const test = require('node:test');
const jwt = require('jsonwebtoken');
const { io: createSocketClient } = require('socket.io-client');
const { createRealtimeServer } = require('../src/services/realtime');

const SECRET = 'realtime-test-secret';
const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';
const CRAWL_ID = '33333333-3333-4333-8333-333333333333';
const WEBSITE_ID = '44444444-4444-4444-8444-444444444444';

function tokenFor(userId, options = {}) {
  return jwt.sign({ userId }, SECRET, { expiresIn: '1h', ...options });
}

async function createFixture() {
  const users = new Map([
    [OWNER_ID, { id: OWNER_ID, isActive: true }],
    [OTHER_ID, { id: OTHER_ID, isActive: true }],
  ]);
  const prisma = {
    user: {
      findUnique: async ({ where }) => users.get(where.id) ?? null,
    },
    crawlResult: {
      findFirst: async ({ where }) =>
        where.id === CRAWL_ID && where.userId === OWNER_ID
          ? { id: CRAWL_ID, websiteId: WEBSITE_ID }
          : null,
    },
    notification: {
      create: async ({ data }) => {
        const key = `${data.crawlId}:${data.type}`;
        if (notifications.has(key)) {
          const error = new Error('Unique constraint failed');
          error.code = 'P2002';
          throw error;
        }
        const notification = {
          id: `notification-${notifications.size + 1}`,
          ...data,
          readAt: null,
          createdAt: new Date().toISOString(),
        };
        notifications.set(key, notification);
        return notification;
      },
      findUnique: async ({ where }) => {
        const key = `${where.crawlId_type.crawlId}:${where.crawlId_type.type}`;
        return notifications.get(key) ?? null;
      },
    },
  };
  const notifications = new Map();
  const httpServer = http.createServer();
  const realtime = createRealtimeServer(httpServer, {
    jwtSecret: SECRET,
    prisma,
    origin: '*',
  });
  httpServer.listen(0);
  await once(httpServer, 'listening');
  const address = httpServer.address();
  const url = `http://127.0.0.1:${address.port}`;

  return {
    realtime,
    httpServer,
    url,
    notificationCount: () => notifications.size,
    client(accessToken) {
      return createSocketClient(url, {
        autoConnect: false,
        reconnection: false,
        auth: { accessToken },
      });
    },
  };
}

async function closeFixture(fixture, clients = []) {
  clients.forEach((client) => client.disconnect());
  await fixture.realtime.close();
  if (fixture.httpServer.listening) {
    await new Promise((resolve) => fixture.httpServer.close(resolve));
  }
}

function connect(socket) {
  return new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
    socket.connect();
  });
}

function expectConnectError(socket) {
  return new Promise((resolve, reject) => {
    socket.once('connect_error', resolve);
    socket.once('connect', () =>
      reject(new Error('Socket unexpectedly connected'))
    );
    socket.connect();
  });
}

function nextEvent(socket, name) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Timed out waiting for ${name}`)),
      1500
    );
    socket.once(name, (payload) => {
      clearTimeout(timeout);
      resolve(payload);
    });
  });
}

test('rejects missing, invalid, and expired access tokens', async (t) => {
  const fixture = await createFixture();
  const clients = [];
  t.after(() => closeFixture(fixture, clients));

  const missing = fixture.client(undefined);
  clients.push(missing);
  const missingError = await expectConnectError(missing);
  assert.equal(missingError.data.code, 'TOKEN_MISSING');

  const invalid = fixture.client('not-a-jwt');
  clients.push(invalid);
  const invalidError = await expectConnectError(invalid);
  assert.equal(invalidError.data.code, 'INVALID_TOKEN');

  const expired = fixture.client(tokenFor(OWNER_ID, { expiresIn: -1 }));
  clients.push(expired);
  const expiredError = await expectConnectError(expired);
  assert.equal(expiredError.data.code, 'TOKEN_EXPIRED');
});

test('disconnects an established socket when its access token expires', async (t) => {
  const fixture = await createFixture();
  const owner = fixture.client(tokenFor(OWNER_ID, { expiresIn: 1 }));
  t.after(() => closeFixture(fixture, [owner]));
  await connect(owner);

  const expiryEvent = nextEvent(owner, 'auth:expired');
  const disconnectEvent = once(owner, 'disconnect');
  await Promise.all([expiryEvent, disconnectEvent]);
  assert.equal(owner.connected, false);
});

test('delivers only to the owner and validates crawl ownership', async (t) => {
  const fixture = await createFixture();
  const owner = fixture.client(tokenFor(OWNER_ID));
  const other = fixture.client(tokenFor(OTHER_ID));
  t.after(() => closeFixture(fixture, [owner, other]));
  await Promise.all([connect(owner), connect(other)]);

  const startedEvent = nextEvent(owner, 'crawl:started');
  assert.equal(
    await fixture.realtime.publishCrawlEvent({
      crawlId: CRAWL_ID,
      websiteId: WEBSITE_ID,
      userId: OWNER_ID,
      status: 'running',
      progress: 0,
    }),
    true
  );
  assert.equal((await startedEvent).progress, 0);

  const ownerEvent = nextEvent(owner, 'crawl:progress');
  const otherReceived = new Promise((resolve) => {
    other.once('crawl:progress', () => resolve(true));
    setTimeout(() => resolve(false), 150);
  });

  const sent = await fixture.realtime.publishCrawlEvent({
    crawlId: CRAWL_ID,
    websiteId: WEBSITE_ID,
    userId: OWNER_ID,
    status: 'running',
    progress: 45,
  });

  assert.equal(sent, true);
  assert.deepEqual(await ownerEvent, {
    crawlId: CRAWL_ID,
    websiteId: WEBSITE_ID,
    status: 'running',
    progress: 45,
  });
  assert.equal(await otherReceived, false);
  assert.equal(
    await fixture.realtime.publishCrawlEvent({
      crawlId: CRAWL_ID,
      websiteId: WEBSITE_ID,
      userId: OTHER_ID,
      status: 'running',
      progress: 50,
    }),
    false
  );
  assert.equal(
    await fixture.realtime.publishCrawlEvent({
      crawlId: CRAWL_ID,
      websiteId: WEBSITE_ID,
      userId: OWNER_ID,
      status: 'running',
      progress: 101,
    }),
    false
  );
});

test('reconnects without duplicate delivery and receives completed/failed events', async (t) => {
  const fixture = await createFixture();
  const owner = fixture.client(tokenFor(OWNER_ID));
  t.after(() => closeFixture(fixture, [owner]));
  await connect(owner);
  owner.disconnect();
  await connect(owner);

  const completed = nextEvent(owner, 'crawl:completed');
  const completedNotification = nextEvent(owner, 'notification:new');
  await fixture.realtime.publishCrawlEvent({
    crawlId: CRAWL_ID,
    websiteId: WEBSITE_ID,
    userId: OWNER_ID,
    status: 'completed',
    progress: 100,
    completedAt: new Date().toISOString(),
    totalLinksFound: 25,
    totalLinksChecked: 25,
    brokenLinksFound: 2,
  });
  assert.equal((await completed).brokenLinksFound, 2);
  assert.equal((await completedNotification).type, 'crawl_completed');

  const failed = nextEvent(owner, 'crawl:failed');
  const failedNotification = nextEvent(owner, 'notification:new');
  await fixture.realtime.publishCrawlEvent({
    crawlId: CRAWL_ID,
    websiteId: WEBSITE_ID,
    userId: OWNER_ID,
    status: 'failed',
    progress: 40,
    completedAt: new Date().toISOString(),
    errorMessage: 'Crawl timed out',
  });
  assert.equal((await failed).status, 'failed');
  assert.equal((await failedNotification).type, 'crawl_failed');

  const duplicateNotification = new Promise((resolve) => {
    owner.once('notification:new', () => resolve(true));
    setTimeout(() => resolve(false), 100);
  });
  await fixture.realtime.publishCrawlEvent({
    crawlId: CRAWL_ID,
    websiteId: WEBSITE_ID,
    userId: OWNER_ID,
    status: 'completed',
    progress: 100,
    completedAt: new Date().toISOString(),
    totalLinksFound: 25,
    totalLinksChecked: 25,
    brokenLinksFound: 2,
  });
  assert.equal(await duplicateNotification, false);
  assert.equal(fixture.notificationCount(), 2);

  let duplicateCount = 0;
  owner.on('crawl:progress', () => {
    duplicateCount += 1;
  });
  const runningEvent = nextEvent(owner, 'crawl:progress');
  await fixture.realtime.publishCrawlEvent({
    crawlId: CRAWL_ID,
    websiteId: WEBSITE_ID,
    userId: OWNER_ID,
    status: 'running',
    progress: 60,
  });
  await runningEvent;
  assert.equal(duplicateCount, 1);
});
