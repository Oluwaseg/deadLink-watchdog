'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // First, remove the default value
    await queryInterface.changeColumn('websites', 'crawlFrequency', {
      type: Sequelize.ENUM('daily', 'weekly', 'monthly'),
      allowNull: true,
      defaultValue: null
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.changeColumn('websites', 'crawlFrequency', {
      type: Sequelize.ENUM('daily', 'weekly', 'monthly'),
      allowNull: false,
      defaultValue: 'weekly'
    });
  }
};
