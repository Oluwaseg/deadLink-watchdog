'use strict';

module.exports = (sequelize, DataTypes) => {
  const CrawlResult = sequelize.define(
    'CrawlResult',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      websiteId: {
        type: DataTypes.UUID,
        allowNull: false,
        references: {
          model: 'websites',
          key: 'id',
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
      status: {
        type: DataTypes.ENUM('pending', 'running', 'completed', 'failed'),
        defaultValue: 'pending',
      },
      startedAt: {
        type: DataTypes.DATE,
      },
      completedAt: {
        type: DataTypes.DATE,
      },
      totalLinksFound: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
      },
      totalLinksChecked: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
      },
      brokenLinksFound: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
      },
      redirectsFound: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
      },
      timeoutsFound: {
        type: DataTypes.INTEGER,
        defaultValue: 0,
      },
      averageResponseTime: {
        type: DataTypes.INTEGER, // in milliseconds
        defaultValue: 0,
      },
      errorMessage: {
        type: DataTypes.TEXT,
      },
      crawlDepth: {
        type: DataTypes.INTEGER,
        defaultValue: 1,
        validate: {
          min: 1,
          max: 5,
        },
      },
      userAgent: {
        type: DataTypes.STRING,
      },
      summary: {
        type: DataTypes.JSONB,
        defaultValue: {},
      },
    },
    {
      tableName: 'crawl_results',
      timestamps: true,
      indexes: [
        {
          fields: ['websiteId'],
        },
        {
          fields: ['userId'],
        },
        {
          fields: ['status'],
        },
        {
          fields: ['createdAt'],
        },
      ],
    }
  );

  CrawlResult.associate = function (models) {
    CrawlResult.belongsTo(models.Website, {
      foreignKey: 'websiteId',
      as: 'website',
    });
    CrawlResult.belongsTo(models.User, {
      foreignKey: 'userId',
      as: 'user',
    });
    CrawlResult.hasMany(models.BrokenLink, {
      foreignKey: 'crawlResultId',
      as: 'brokenLinkRecords',
    });
  };

  CrawlResult.prototype.calculateDuration = function () {
    if (!this.startedAt || !this.completedAt) return null;
    return this.completedAt - this.startedAt;
  };

  CrawlResult.prototype.getSuccessRate = function () {
    if (this.totalLinksChecked === 0) return 100;
    const successfulLinks = this.totalLinksChecked - this.brokenLinksFound;
    return (successfulLinks / this.totalLinksChecked) * 100;
  };

  return CrawlResult;
};
