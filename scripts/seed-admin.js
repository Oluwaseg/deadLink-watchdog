require('dotenv').config();

const prisma = require('../src/lib/prisma');
const { hashPassword } = require('../src/utils/password');

async function seedAdmin() {
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  const firstName = process.env.ADMIN_FIRST_NAME?.trim();
  const lastName = process.env.ADMIN_LAST_NAME?.trim();

  if (!email || !password || !firstName || !lastName) {
    throw new Error(
      'Set ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_FIRST_NAME, and ADMIN_LAST_NAME before running the seed.'
    );
  }

  if (password.length < 12) {
    throw new Error('ADMIN_PASSWORD must be at least 12 characters long.');
  }

  const existingUser = await prisma.user.findUnique({ where: { email } });
  const user = existingUser
    ? await prisma.user.update({
        where: { email },
        data: {
          firstName,
          lastName,
          role: 'admin',
          isActive: true,
          emailVerified: true,
        },
      })
    : await prisma.user.create({
        data: {
          email,
          password: await hashPassword(password),
          firstName,
          lastName,
          role: 'admin',
          isActive: true,
          emailVerified: true,
        },
      });

  console.log(`Admin account ready for ${user.email}.`);
}

seedAdmin()
  .catch((error) => {
    console.error('Failed to seed admin account:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
