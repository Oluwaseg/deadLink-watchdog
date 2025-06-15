// scripts/drop-tables.js
const { Sequelize } = require('sequelize');
const config =
  require('../config/database')[process.env.NODE_ENV || 'development'];

async function dropAll() {
  const sequelize = new Sequelize(
    config.database,
    config.username,
    config.password,
    config
  );

  try {
    await sequelize.authenticate();
    console.log('🔗 Connected to database');

    const drop = async (sql, msg) => {
      await sequelize.query(sql);
      console.log(msg);
    };

    await drop(
      'DROP TABLE IF EXISTS broken_links CASCADE;',
      '🗑️ Dropped broken_links'
    );
    await drop(
      'DROP TABLE IF EXISTS crawl_results CASCADE;',
      '🗑️ Dropped crawl_results'
    );
    await drop('DROP TABLE IF EXISTS websites CASCADE;', '🗑️ Dropped websites');
    await drop('DROP TABLE IF EXISTS users CASCADE;', '🗑️ Dropped users');
    await drop(
      'DROP TABLE IF EXISTS "SequelizeMeta" CASCADE;',
      '🗑️ Dropped SequelizeMeta'
    );

    await drop(
      'DROP TYPE IF EXISTS enum_users_role CASCADE;',
      '🧹 Dropped enum_users_role'
    );
    await drop(
      'DROP TYPE IF EXISTS enum_websites_category CASCADE;',
      '🧹 Dropped enum_websites_category'
    );
    await drop(
      'DROP TYPE IF EXISTS enum_websites_crawlFrequency CASCADE;',
      '🧹 Dropped enum_websites_crawlFrequency'
    );
    await drop(
      'DROP TYPE IF EXISTS enum_crawl_results_status CASCADE;',
      '🧹 Dropped enum_crawl_results_status'
    );
    await drop(
      'DROP TYPE IF EXISTS enum_broken_links_errorType CASCADE;',
      '🧹 Dropped enum_broken_links_errorType'
    );

    console.log('✅ All tables and enums dropped successfully!');
    await sequelize.close();
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

dropAll();
