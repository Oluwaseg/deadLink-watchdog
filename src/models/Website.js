'use strict';

module.exports = (sequelize, DataTypes) => {
  const Website = sequelize.define(
    'Website',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      url: {
        type: DataTypes.STRING,
        allowNull: false,
        validate: {
          isUrl: true,
        },
      },
      name: {
        type: DataTypes.STRING,
        allowNull: false,
        validate: {
          len: [2, 100],
        },
      },
      description: {
        type: DataTypes.TEXT,
      },
      category: {
        type: DataTypes.ENUM(
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
        type: DataTypes.BOOLEAN,
        defaultValue: true,
      },
      crawlFrequency: {
        type: DataTypes.ENUM('daily', 'weekly', 'monthly'),
        allowNull: true,
        defaultValue: null,
      },
      lastCrawledAt: {
        type: DataTypes.DATE,
      },
      nextCrawlAt: {
        type: DataTypes.DATE,
      },
      totalLinks: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
      },
      brokenLinks: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
      },
      healthScore: {
        type: DataTypes.DECIMAL(5, 2),
        defaultValue: 100.0,
        validate: {
          min: 0,
          max: 100,
        },
      },
      notificationEmail: {
        type: DataTypes.STRING,
        validate: {
          isEmail: true,
        },
      },
      webhookUrl: {
        type: DataTypes.STRING,
        validate: {
          isUrl: true,
        },
      },
      userId: {
        type: DataTypes.UUID,
        allowNull: false,
        references: {
          model: 'users',
          key: 'id',
        },
      },
    },
    {
      tableName: 'websites',
      timestamps: true,
      indexes: [
        {
          fields: ['userId'],
        },
        {
          fields: ['isActive'],
        },
        {
          fields: ['nextCrawlAt'],
        },
        {
          fields: ['category'],
        },
      ],
    }
  );

  Website.associate = function (models) {
    Website.belongsTo(models.User, {
      foreignKey: 'userId',
      as: 'user',
    });
    Website.hasMany(models.CrawlResult, {
      foreignKey: 'websiteId',
      as: 'crawlResults',
    });
    Website.hasMany(models.BrokenLink, {
      foreignKey: 'websiteId',
      as: 'brokenLinkRecords',
    });
  };

  Website.prototype.calculateHealthScore = function () {
    if (this.totalLinks === 0) return 100;
    const brokenPercentage = (this.brokenLinks / this.totalLinks) * 100;
    return Math.max(0, 100 - brokenPercentage);
  };

  Website.prototype.updateHealthScore = async function () {
    this.healthScore = this.calculateHealthScore();
    await this.save();
  };

  return Website;
};
