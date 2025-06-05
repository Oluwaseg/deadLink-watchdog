'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('websites', {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
      },
      url: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      name: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      description: {
        type: Sequelize.TEXT,
      },
      category: {
        type: Sequelize.ENUM(
          'news',
          'government',
          'business',
          'education',
          'entertainment',
          'financial',
          'other'
        ),
        defaultValue: 'other',
      },
      isActive: {
        type: Sequelize.BOOLEAN,
        defaultValue: true,
      },
      crawlFrequency: {
        type: Sequelize.ENUM('daily', 'weekly', 'monthly'),
        defaultValue: 'weekly',
      },
      lastCrawledAt: {
        type: Sequelize.DATE,
      },
      nextCrawlAt: {
        type: Sequelize.DATE,
      },
      totalLinks: {
        type: Sequelize.INTEGER,
        defaultValue: 0,
      },
      brokenLinks: {
        type: Sequelize.INTEGER,
        defaultValue: 0,
      },
      healthScore: {
        type: Sequelize.DECIMAL(5, 2),
        defaultValue: 100.0,
      },
      notificationEmail: {
        type: Sequelize.STRING,
      },
      webhookUrl: {
        type: Sequelize.STRING,
      },
      userId: {
        type: Sequelize.UUID,
        allowNull: false,
        references: {
          model: 'users',
          key: 'id',
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      createdAt: {
        allowNull: false,
        type: Sequelize.DATE,
      },
      updatedAt: {
        allowNull: false,
        type: Sequelize.DATE,
      },
    });

    // Add indexes (with error handling for existing indexes)
    try {
      await queryInterface.addIndex('websites', ['userId'], {
        name: 'websites_user_id',
      });
    } catch (error) {
      if (!error.message.includes('already exists')) throw error;
    }

    try {
      await queryInterface.addIndex('websites', ['isActive'], {
        name: 'websites_is_active',
      });
    } catch (error) {
      if (!error.message.includes('already exists')) throw error;
    }

    try {
      await queryInterface.addIndex('websites', ['nextCrawlAt'], {
        name: 'websites_next_crawl_at',
      });
    } catch (error) {
      if (!error.message.includes('already exists')) throw error;
    }

    try {
      await queryInterface.addIndex('websites', ['category'], {
        name: 'websites_category',
      });
    } catch (error) {
      if (!error.message.includes('already exists')) throw error;
    }
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('websites');
  },
};
