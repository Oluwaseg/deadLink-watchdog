const MAX_EMAIL_VERIFICATION_ATTEMPTS = 5;

async function verifyEmailCode(prisma, email, code, now = new Date()) {
  const user = await prisma.user.findFirst({
    where: {
      email,
      emailVerified: false,
      emailVerificationExpires: { gt: now },
    },
    select: {
      id: true,
      emailVerificationCode: true,
      emailVerificationAttempts: true,
    },
  });

  if (
    !user ||
    user.emailVerificationAttempts >= MAX_EMAIL_VERIFICATION_ATTEMPTS
  ) {
    return null;
  }

  const claimWhere = {
    id: user.id,
    emailVerified: false,
    emailVerificationAttempts: user.emailVerificationAttempts,
    emailVerificationExpires: { gt: now },
  };

  if (user.emailVerificationCode !== code) {
    await prisma.user.updateMany({
      where: claimWhere,
      data: { emailVerificationAttempts: { increment: 1 } },
    });
    return null;
  }

  const verified = await prisma.user.updateMany({
    where: { ...claimWhere, emailVerificationCode: code },
    data: {
      emailVerified: true,
      emailVerificationCode: null,
      emailVerificationExpires: null,
      emailVerificationAttempts: 0,
    },
  });
  if (verified.count !== 1) return null;

  return prisma.user.findUnique({ where: { id: user.id } });
}

module.exports = { MAX_EMAIL_VERIFICATION_ATTEMPTS, verifyEmailCode };
