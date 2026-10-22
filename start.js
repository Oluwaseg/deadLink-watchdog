#!/usr/bin/env node

/**
 * Startup script for DeadLink Watchdog
 * Handles database setup and starts the server
 */

const { execSync } = require('child_process');
const fs = require('fs');

async function checkPrerequisites() {
  console.log('🔍 Checking prerequisites...\n');

  // Check if .env file exists
  if (!fs.existsSync('.env')) {
    console.log('⚠️  .env file not found. Creating from .env.example...');
    if (fs.existsSync('.env.example')) {
      fs.copyFileSync('.env.example', '.env');
      console.log(
        '✅ .env file created. Please update it with your configuration.\n'
      );
    } else {
      console.error(
        '❌ .env.example file not found. Please create .env manually.'
      );
      process.exit(1);
    }
  }

  // Check Node.js version
  const nodeVersion = process.version;
  const majorVersion = parseInt(nodeVersion.slice(1).split('.')[0]);
  if (majorVersion < 16) {
    console.error(
      `❌ Node.js version ${nodeVersion} is not supported. Please use Node.js 16 or higher.`
    );
    process.exit(1);
  }
  console.log(`✅ Node.js version: ${nodeVersion}`);

  console.log('✅ Prerequisites check completed\n');
}

async function setupDatabase() {
  console.log('🗄️  Setting up database...\n');

  try {
    console.log('Generating Prisma client...');
    execSync('prisma generate', {
      stdio: 'inherit',
    });

    console.log('Applying Prisma migrations...');
    execSync('prisma migrate deploy', {
      stdio: 'inherit',
    });
    console.log('✅ Database setup completed');
  } catch (error) {
    console.error('❌ Database setup failed:', error.message);
    console.log(
      '\n💡 Make sure PostgreSQL is running and DATABASE_URL in .env is correct'
    );
    process.exit(1);
  }
}

async function startServer() {
  console.log('🚀 Starting DeadLink Watchdog server...\n');

  try {
    const app = require('./src/app');
    await app.start();
  } catch (error) {
    console.error('❌ Failed to start server:', error.message);

    if (error.message.includes('Redis')) {
      console.log('💡 Make sure Redis is running on the configured port');
    } else if (
      error.message.includes('database') ||
      error.message.includes('Prisma')
    ) {
      console.log('💡 Check your DATABASE_URL configuration in .env');
    }

    process.exit(1);
  }
}

async function main() {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║                    DeadLink Watchdog 🐕‍🦺                      ║
║              Nigerian Website Link Monitor                   ║
╚══════════════════════════════════════════════════════════════╝
`);

  try {
    await checkPrerequisites();
    await setupDatabase();
    await startServer();
  } catch (error) {
    console.error('❌ Startup failed:', error.message);
    process.exit(1);
  }
}

process.on('SIGINT', () => {
  console.log('\n👋 Shutting down gracefully...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n👋 Shutting down gracefully...');
  process.exit(0);
});

if (require.main === module) {
  main().catch(console.error);
}

module.exports = { main, checkPrerequisites, setupDatabase, startServer };
