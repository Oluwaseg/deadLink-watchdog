'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('crawl_results', {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
      },
      websiteId: {
        type: Sequelize.UUID,
        allowNull: false,
        references: {
          model: 'websites',
          key: 'id',
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
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
      status: {
        type: Sequelize.ENUM('pending', 'running', 'completed', 'failed'),
        defaultValue: 'pending',
      },
      startedAt: {
        type: Sequelize.DATE,
      },
      completedAt: {
        type: Sequelize.DATE,
      },
      totalLinksFound: {
        type: Sequelize.INTEGER,
        defaultValue: 0,
      },
      totalLinksChecked: {
        type: Sequelize.INTEGER,
        defaultValue: 0,
      },
      brokenLinksFound: {
        type: Sequelize.INTEGER,
        defaultValue: 0,
      },
      redirectsFound: {
        type: Sequelize.INTEGER,
        defaultValue: 0,
      },
      timeoutsFound: {
        type: Sequelize.INTEGER,
        defaultValue: 0,
      },
      averageResponseTime: {
        type: Sequelize.INTEGER,
        defaultValue: 0,
      },
      errorMessage: {
        type: Sequelize.TEXT,
      },
      crawlDepth: {
        type: Sequelize.INTEGER,
        defaultValue: 1,
      },
      userAgent: {
        type: Sequelize.STRING,
      },
      summary: {
        type: Sequelize.JSONB,
        defaultValue: {},
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
      await queryInterface.addIndex('crawl_results', ['websiteId'], {
        name: 'crawl_results_website_id',
      });
    } catch (error) {
      if (!error.message.includes('already exists')) throw error;
    }

    try {
      await queryInterface.addIndex('crawl_results', ['userId'], {
        name: 'crawl_results_user_id',
      });
    } catch (error) {
      if (!error.message.includes('already exists')) throw error;
    }

    try {
      await queryInterface.addIndex('crawl_results', ['status'], {
        name: 'crawl_results_status',
      });
    } catch (error) {
      if (!error.message.includes('already exists')) throw error;
    }

    try {
      await queryInterface.addIndex('crawl_results', ['createdAt'], {
        name: 'crawl_results_created_at',
      });
    } catch (error) {
      if (!error.message.includes('already exists')) throw error;
    }
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('crawl_results');
  },
};
