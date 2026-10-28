const assert = require('node:assert/strict');
const test = require('node:test');
const {
  MAX_EMAIL_VERIFICATION_ATTEMPTS,
  verifyEmailCode,
} = require('../src/services/emailVerification');

function makePrismaFixture() {
  const user = {
    id: 'verification-user',
    email: 'verify@example.invalid',
    emailVerified: false,
    emailVerificationCode: '314159',
    emailVerificationExpires: new Date(Date.now() + 60_000),
    emailVerificationAttempts: 0,
  };
  return {
    user,
    userModel: {
      findFirst: async ({ where }) => {
        if (
          where.email !== user.email ||
          user.emailVerified !== where.emailVerified ||
          user.emailVerificationExpires <= where.emailVerificationExpires.gt
        ) {
          return null;
        }
        return { ...user };
      },
      updateMany: async ({ where, data }) => {
        if (
          user.id !== where.id ||
          user.emailVerified !== where.emailVerified ||
          user.emailVerificationAttempts !== where.emailVerificationAttempts ||
          user.emailVerificationExpires <= where.emailVerificationExpires.gt ||
          (where.emailVerificationCode &&
            user.emailVerificationCode !== where.emailVerificationCode)
        ) {
          return { count: 0 };
        }
        if (data.emailVerificationAttempts?.increment) {
          user.emailVerificationAttempts +=
            data.emailVerificationAttempts.increment;
        }
        if (data.emailVerified !== undefined)
          user.emailVerified = data.emailVerified;
        if (data.emailVerificationCode !== undefined)
          user.emailVerificationCode = data.emailVerificationCode;
        if (data.emailVerificationExpires !== undefined)
          user.emailVerificationExpires = data.emailVerificationExpires;
        if (data.emailVerificationAttempts === 0)
          user.emailVerificationAttempts = 0;
        return { count: 1 };
      },
      findUnique: async ({ where }) =>
        where.id === user.id ? { ...user } : null,
    },
  };
}

test('email verification rejects and counts guesses then locks the current code', async () => {
  const fixture = makePrismaFixture();
  const prisma = { user: fixture.userModel };
  for (
    let attempt = 1;
    attempt <= MAX_EMAIL_VERIFICATION_ATTEMPTS;
    attempt += 1
  ) {
    assert.equal(
      await verifyEmailCode(prisma, fixture.user.email, '000000'),
      null
    );
    assert.equal(fixture.user.emailVerificationAttempts, attempt);
  }
  assert.equal(
    await verifyEmailCode(prisma, fixture.user.email, '314159'),
    null
  );
  assert.equal(fixture.user.emailVerified, false);
  assert.equal(
    fixture.user.emailVerificationAttempts,
    MAX_EMAIL_VERIFICATION_ATTEMPTS
  );
});

test('concurrent invalid verification attempts cannot exceed the database attempt cap', async () => {
  const fixture = makePrismaFixture();
  fixture.user.emailVerificationAttempts = MAX_EMAIL_VERIFICATION_ATTEMPTS - 1;
  const prisma = { user: fixture.userModel };
  await Promise.all(
    Array.from({ length: 10 }, () =>
      verifyEmailCode(prisma, fixture.user.email, '000000')
    )
  );
  assert.equal(
    fixture.user.emailVerificationAttempts,
    MAX_EMAIL_VERIFICATION_ATTEMPTS
  );
  assert.equal(fixture.user.emailVerified, false);
});

test('a valid verification code is atomically consumed once', async () => {
  const fixture = makePrismaFixture();
  const prisma = { user: fixture.userModel };
  const [first, second] = await Promise.all([
    verifyEmailCode(prisma, fixture.user.email, '314159'),
    verifyEmailCode(prisma, fixture.user.email, '314159'),
  ]);
  assert.equal([first, second].filter(Boolean).length, 1);
  assert.equal(fixture.user.emailVerified, true);
  assert.equal(fixture.user.emailVerificationCode, null);
  assert.equal(fixture.user.emailVerificationAttempts, 0);
});

test('expired verification codes are not accepted', async () => {
  const fixture = makePrismaFixture();
  fixture.user.emailVerificationExpires = new Date(Date.now() - 1);
  const prisma = { user: fixture.userModel };
  assert.equal(
    await verifyEmailCode(prisma, fixture.user.email, '314159'),
    null
  );
  assert.equal(fixture.user.emailVerified, false);
});
