const bcrypt = require('bcryptjs');

async function hashPassword(password) {
  return bcrypt.hash(password, 12);
}

async function validatePassword(plainPassword, hashedPassword) {
  return bcrypt.compare(plainPassword, hashedPassword);
}

function excludePassword(user) {
  if (!user) return user;
  const { password, ...safeUser } = user;
  return safeUser;
}

module.exports = {
  hashPassword,
  validatePassword,
  excludePassword,
};
