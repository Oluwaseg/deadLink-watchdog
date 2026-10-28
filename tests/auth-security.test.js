const assert = require('node:assert/strict');
const http = require('node:http');
const Module = require('node:module');
const { once } = require('node:events');
const test = require('node:test');

const routePath = require.resolve('../src/routes/auth');
let fixture;
const prisma = {
  user: {
    findUnique: async ({ where }) =>
      fixture.user?.email === where.email || fixture.user?.id === where.id
        ? { ...fixture.user }
        : null,
    update: async ({ where, data }) => {
      if (!fixture.user || fixture.user.id !== where.id) return null;
      Object.assign(fixture.user, data);
      return { ...fixture.user };
    },
    updateMany: async ({ where, data }) => {
      const tokenMatches =
        fixture.user?.resetPasswordToken === where.resetPasswordToken;
      const expiryMatches =
        fixture.user?.resetPasswordExpires > where.resetPasswordExpires.gt;
      if (fixture.user?.id !== where.id || !tokenMatches || !expiryMatches) {
        return { count: 0 };
      }
      Object.assign(fixture.user, data);
      return { count: 1 };
    },
    findFirst: async ({ where }) => {
      const user = fixture.user;
      if (!user || user.resetPasswordToken !== where.resetPasswordToken)
        return null;
      if (user.resetPasswordExpires <= where.resetPasswordExpires.gt)
        return null;
      return { ...user };
    },
  },
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (parent?.filename === routePath) {
    if (request === '../lib/prisma') return prisma;
    if (request === '../utils/password') {
      return {
        hashPassword: async (value) => `hashed:${value}`,
        validatePassword: async () => true,
      };
    }
    if (request === '../middleware/auth') {
      return {
        generateTokens: () => ({
          accessToken: 'access-test',
          refreshToken: 'refresh-test',
        }),
        verifyRefreshToken: () => ({ userId: 'user-id' }),
        authenticateToken: (req, res, next) => {
          req.user = { id: 'user-id' };
          next();
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
    if (request === '../services/email') {
      return {
        sendVerificationEmail: async () => {},
        sendWelcomeEmail: async () => {},
        sendPasswordResetEmail: async (...args) =>
          fixture.resetEmails.push(args),
      };
    }
    if (request === '../services/emailVerification') {
      return { verifyEmailCode: async () => null };
    }
  }
  return originalLoad.call(this, request, parent, isMain);
};
const authRouter = require(routePath);
Module._load = originalLoad;

async function startFixture(t) {
  fixture = {
    user: {
      id: 'user-id',
      email: 'person@example.invalid',
      firstName: 'Test',
      lastName: 'User',
      resetPasswordToken: null,
      resetPasswordExpires: null,
      password: 'old-hash',
    },
    resetEmails: [],
  };
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
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
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/auth`;
  return {
    post: (path, body) =>
      fetch(`${baseUrl}/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
  };
}

test('forgot-password never returns the reset token in development responses', async (t) => {
  const api = await startFixture(t);
  const originalNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'development';
  try {
    const response = await api.post('forgot-password', {
      email: fixture.user.email,
    });
    const payload = await response.json();
    const mailedToken = fixture.resetEmails[0]?.[1];
    assert.equal(response.status, 200);
    assert.equal(typeof mailedToken, 'string');
    assert.equal('resetToken' in payload, false);
    assert.equal(JSON.stringify(payload).includes(mailedToken), false);
  } finally {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  }
});

test('one reset token can update a password only once under concurrent requests', async (t) => {
  const api = await startFixture(t);
  fixture.user.resetPasswordToken = 'single-use-token';
  fixture.user.resetPasswordExpires = new Date(Date.now() + 60_000);
  const responses = await Promise.all([
    api.post('reset-password', {
      token: 'single-use-token',
      newPassword: 'new-password-one',
    }),
    api.post('reset-password', {
      token: 'single-use-token',
      newPassword: 'new-password-two',
    }),
  ]);
  assert.deepEqual(
    responses.map((response) => response.status).sort(),
    [200, 400]
  );
  assert.equal(fixture.user.resetPasswordToken, null);
  assert.equal(fixture.user.resetPasswordExpires, null);
  assert.ok(
    ['hashed:new-password-one', 'hashed:new-password-two'].includes(
      fixture.user.password
    )
  );
});

test('expired reset token is rejected without changing the password', async (t) => {
  const api = await startFixture(t);
  fixture.user.resetPasswordToken = 'expired-token';
  fixture.user.resetPasswordExpires = new Date(Date.now() - 1000);
  const response = await api.post('reset-password', {
    token: 'expired-token',
    newPassword: 'new-password',
  });
  assert.equal(response.status, 400);
  assert.equal(fixture.user.password, 'old-hash');
});
