'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('websites', 'isFlagged', {
      type: Sequelize.BOOLEAN,
      defaultValue: false
    });

    await queryInterface.addColumn('websites', 'reports', {
      type: Sequelize.INTEGER,
      defaultValue: 0
    });

    await queryInterface.addColumn('websites', 'moderatedAt', {
      type: Sequelize.DATE,
      allowNull: true
    });

    await queryInterface.addColumn('websites', 'moderatedBy', {
      type: Sequelize.UUID,
      allowNull: true,
      references: {
        model: 'users',
        key: 'id'
      }
    });

    // Add index for moderation queries
    await queryInterface.addIndex('websites', ['isFlagged', 'reports'], {
      name: 'websites_moderation_idx'
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeColumn('websites', 'isFlagged');
    await queryInterface.removeColumn('websites', 'reports');
    await queryInterface.removeColumn('websites', 'moderatedAt');
    await queryInterface.removeColumn('websites', 'moderatedBy');
    await queryInterface.removeIndex('websites', 'websites_moderation_idx');
  }
};
