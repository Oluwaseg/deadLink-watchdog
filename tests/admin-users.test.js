const assert = require('node:assert/strict');
const http = require('node:http');
const Module = require('node:module');
const { once } = require('node:events');
const test = require('node:test');

const routePath = require.resolve('../src/routes/admin');
const ADMIN_ID = '11111111-1111-4111-8111-111111111111';

let fixture;
let lastFindManyArgs;
const prisma = {
  user: {
    findMany: async (args) => {
      lastFindManyArgs = args;
      const search = args.where.OR?.[0]?.email?.contains;
      return fixture.users
        .filter((user) => {
          if (args.where.role && user.role !== args.where.role) return false;
          if (
            args.where.isActive !== undefined &&
            user.isActive !== args.where.isActive
          ) {
            return false;
          }
          if (
            search &&
            ![user.email, user.firstName, user.lastName].some((value) =>
              value.toLowerCase().includes(search.toLowerCase())
            )
          ) {
            return false;
          }
          return true;
        })
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .slice(args.skip, args.skip + args.take)
        .map((user) => {
          const selected = {};
          for (const [field, include] of Object.entries(args.select)) {
            if (field === '_count') {
              selected._count = {
                websites: fixture.websites.filter(
                  (website) => website.userId === user.id
                ).length,
              };
            } else if (include) {
              selected[field] = user[field];
            }
          }
          return selected;
        });
    },
    count: async ({ where }) =>
      fixture.users.filter((user) => {
        if (where.role && user.role !== where.role) return false;
        if (where.isActive !== undefined && user.isActive !== where.isActive) {
          return false;
        }
        if (where.OR) {
          const search = where.OR[0].email.contains.toLowerCase();
          if (
            ![user.email, user.firstName, user.lastName].some((value) =>
              value.toLowerCase().includes(search)
            )
          ) {
            return false;
          }
        }
        return true;
      }).length,
  },
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (parent?.filename === routePath) {
    if (request === '../lib/prisma') return prisma;
    if (request === '../utils/password') {
      return { excludePassword: ({ password, ...user }) => user };
    }
    if (request === '../services/queue') {
      return {
        QueueService: class {
          getQueueStats() {
            return Promise.resolve({});
          }
        },
      };
    }
    if (request === '../middleware/auth') {
      return {
        authenticateToken: (req, res, next) => {
          req.user = { id: ADMIN_ID, role: 'admin' };
          next();
        },
        requireAdmin: (req, res, next) => next(),
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
const adminRouter = require(routePath);
Module._load = originalLoad;

function makeUser(id, options = {}) {
  return {
    id,
    email: `${id}@example.test`,
    firstName: `User${id}`,
    lastName: 'Test',
    role: options.role || 'user',
    isActive: options.isActive ?? true,
    createdAt: options.createdAt,
    password: 'must-not-be-returned',
  };
}

async function startFixture(users, websites) {
  fixture = { users, websites };
  lastFindManyArgs = null;
  const express = require('express');
  const app = express();
  app.use('/api/admin', adminRouter);
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
  return {
    async close() {
      server.close();
      await once(server, 'close');
    },
    get query() {
      return lastFindManyArgs;
    },
    get url() {
      return `http://127.0.0.1:${port}/api/admin/users`;
    },
  };
}

test('returns website usage counts with existing filtering, pagination, and safe user fields', async (t) => {
  const users = [
    makeUser('zero', { createdAt: '2026-01-04T00:00:00.000Z' }),
    makeUser('two', { createdAt: '2026-01-03T00:00:00.000Z' }),
    makeUser('three', { createdAt: '2026-01-02T00:00:00.000Z' }),
    makeUser('four', {
      createdAt: '2026-01-01T00:00:00.000Z',
      role: 'admin',
      isActive: false,
    }),
  ];
  const websites = [
    { userId: 'two', isActive: true },
    { userId: 'two', isActive: false },
    { userId: 'three', isActive: true },
    { userId: 'three', isActive: false },
    { userId: 'three', isActive: false },
    { userId: 'four', isActive: true },
    { userId: 'four', isActive: true },
    { userId: 'four', isActive: false },
    { userId: 'four', isActive: false },
  ];
  const fixtureServer = await startFixture(users, websites);
  t.after(() => fixtureServer.close());

  const response = await fetch(fixtureServer.url);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(
    payload.data.users.map((user) => user.websiteCount),
    [0, 2, 3, 4]
  );
  assert.equal(payload.data.pagination.total, 4);
  assert.equal('password' in payload.data.users[0], false);
  assert.deepEqual(fixtureServer.query.select._count, {
    select: { websites: true },
  });
  assert.equal(fixtureServer.query.take, 20);
  assert.equal(fixtureServer.query.skip, 0);

  const filteredResponse = await fetch(
    `${fixtureServer.url}?page=1&limit=1&role=admin&isActive=false&search=four`
  );
  const filteredPayload = await filteredResponse.json();

  assert.equal(filteredResponse.status, 200);
  assert.deepEqual(
    filteredPayload.data.users.map(({ id, websiteCount }) => ({
      id,
      websiteCount,
    })),
    [{ id: 'four', websiteCount: 4 }]
  );
  assert.deepEqual(filteredPayload.data.pagination, {
    page: 1,
    limit: 1,
    total: 1,
    pages: 1,
  });
});
