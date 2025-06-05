'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('broken_links', {
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
      crawlResultId: {
        type: Sequelize.UUID,
        allowNull: false,
        references: {
          model: 'crawl_results',
          key: 'id',
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE',
      },
      url: {
        type: Sequelize.TEXT,
        allowNull: false,
      },
      sourceUrl: {
        type: Sequelize.TEXT,
        allowNull: false,
      },
      linkText: {
        type: Sequelize.TEXT,
      },
      statusCode: {
        type: Sequelize.INTEGER,
      },
      errorType: {
        type: Sequelize.ENUM(
          '404_not_found',
          '403_forbidden',
          '500_server_error',
          'timeout',
          'connection_refused',
          'dns_error',
          'ssl_error',
          'redirect_loop',
          'too_many_redirects',
          'other'
        ),
        allowNull: false,
      },
      errorMessage: {
        type: Sequelize.TEXT,
      },
      responseTime: {
        type: Sequelize.INTEGER,
      },
      redirectChain: {
        type: Sequelize.JSONB,
        defaultValue: [],
      },
      isFixed: {
        type: Sequelize.BOOLEAN,
        defaultValue: false,
      },
      fixedAt: {
        type: Sequelize.DATE,
      },
      firstDetectedAt: {
        type: Sequelize.DATE,
        defaultValue: Sequelize.NOW,
      },
      lastCheckedAt: {
        type: Sequelize.DATE,
        defaultValue: Sequelize.NOW,
      },
      checkCount: {
        type: Sequelize.INTEGER,
        defaultValue: 1,
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
      await queryInterface.addIndex('broken_links', ['websiteId'], {
        name: 'broken_links_website_id',
      });
    } catch (error) {
      if (!error.message.includes('already exists')) throw error;
    }

    try {
      await queryInterface.addIndex('broken_links', ['crawlResultId'], {
        name: 'broken_links_crawl_result_id',
      });
    } catch (error) {
      if (!error.message.includes('already exists')) throw error;
    }

    try {
      await queryInterface.addIndex('broken_links', ['errorType'], {
        name: 'broken_links_error_type',
      });
    } catch (error) {
      if (!error.message.includes('already exists')) throw error;
    }

    try {
      await queryInterface.addIndex('broken_links', ['isFixed'], {
        name: 'broken_links_is_fixed',
      });
    } catch (error) {
      if (!error.message.includes('already exists')) throw error;
    }

    try {
      await queryInterface.addIndex('broken_links', ['url'], {
        name: 'broken_links_url',
      });
    } catch (error) {
      if (!error.message.includes('already exists')) throw error;
    }

    try {
      await queryInterface.addIndex('broken_links', ['sourceUrl'], {
        name: 'broken_links_source_url',
      });
    } catch (error) {
      if (!error.message.includes('already exists')) throw error;
    }
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('broken_links');
  },
};
