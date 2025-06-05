'use strict';

module.exports = (sequelize, DataTypes) => {
  const BrokenLink = sequelize.define('BrokenLink', {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true
    },
    websiteId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: {
        model: 'websites',
        key: 'id'
      }
    },
    crawlResultId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: {
        model: 'crawl_results',
        key: 'id'
      }
    },
    url: {
      type: DataTypes.TEXT,
      allowNull: false
    },
    sourceUrl: {
      type: DataTypes.TEXT,
      allowNull: false
    },
    linkText: {
      type: DataTypes.TEXT
    },
    statusCode: {
      type: DataTypes.INTEGER
    },
    errorType: {
      type: DataTypes.ENUM(
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
      allowNull: false
    },
    errorMessage: {
      type: DataTypes.TEXT
    },
    responseTime: {
      type: DataTypes.INTEGER // in milliseconds
    },
    redirectChain: {
      type: DataTypes.JSONB,
      defaultValue: []
    },
    isFixed: {
      type: DataTypes.BOOLEAN,
      defaultValue: false
    },
    fixedAt: {
      type: DataTypes.DATE
    },
    firstDetectedAt: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW
    },
    lastCheckedAt: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW
    },
    checkCount: {
      type: DataTypes.INTEGER,
      defaultValue: 1
    }
  }, {
    tableName: 'broken_links',
    timestamps: true,
    indexes: [
      {
        fields: ['websiteId']
      },
      {
        fields: ['crawlResultId']
      },
      {
        fields: ['errorType']
      },
      {
        fields: ['isFixed']
      },
      {
        fields: ['url']
      },
      {
        fields: ['sourceUrl']
      }
    ]
  });

  BrokenLink.associate = function(models) {
    BrokenLink.belongsTo(models.Website, {
      foreignKey: 'websiteId',
      as: 'website'
    });
    BrokenLink.belongsTo(models.CrawlResult, {
      foreignKey: 'crawlResultId',
      as: 'crawlResult'
    });
  };

  BrokenLink.prototype.markAsFixed = async function() {
    this.isFixed = true;
    this.fixedAt = new Date();
    await this.save();
  };

  BrokenLink.prototype.incrementCheckCount = async function() {
    this.checkCount += 1;
    this.lastCheckedAt = new Date();
    await this.save();
  };

  return BrokenLink;
};
