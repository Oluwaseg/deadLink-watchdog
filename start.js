#!/usr/bin/env node

/**
 * Startup script for DeadLink Watchdog
 * Handles database setup and starts the server
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

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
    // Run migrations
    console.log('Running database migrations...');
    execSync('npm run db:migrate', { stdio: 'inherit' });
    console.log('✅ Database migrations completed');

    console.log('✅ Database setup completed');
  } catch (error) {
    console.error('❌ Database setup failed:', error.message);
    console.log(
      '\n💡 Make sure PostgreSQL is running and credentials in .env are correct'
    );
    process.exit(1);
  }
}

async function startServer() {
  console.log('🚀 Starting DeadLink Watchdog server...\n');

  try {
    // Import and start the app
    const app = require('./src/app');
    await app.start();
  } catch (error) {
    console.error('❌ Failed to start server:', error.message);

    if (error.message.includes('Redis')) {
      console.log('💡 Make sure Redis is running on the configured port');
    } else if (error.message.includes('database')) {
      console.log('💡 Check your database configuration in .env');
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

    // Check if this is first run (no migrations exist)
    const migrationsPath = path.join(__dirname, 'database', 'migrations');
    const migrationFiles = fs.readdirSync(migrationsPath);

    if (migrationFiles.length > 0) {
      await setupDatabase();
    } else {
      console.log('⚠️  No migration files found. Skipping database setup.');
    }

    await startServer();
  } catch (error) {
    console.error('❌ Startup failed:', error.message);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n👋 Shutting down gracefully...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n👋 Shutting down gracefully...');
  process.exit(0);
});

// Run the startup script
if (require.main === module) {
  main().catch(console.error);
}

module.exports = { main, checkPrerequisites, setupDatabase, startServer };
