const express = require('express');
const { query, validationResult } = require('express-validator');
const { Website, CrawlResult, BrokenLink, User } = require('../models');
const { asyncHandler } = require('../middleware/errorHandler');
const { Op } = require('sequelize');

const router = express.Router();

const checkValidation = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      error: 'Validation failed',
      code: 'VALIDATION_ERROR',
      details: errors.array()
    });
  }
  next();
};

// @route   GET /api/dashboard/overview
// @desc    Get dashboard overview statistics
// @access  Private
router.get('/overview', asyncHandler(async (req, res) => {
  const userId = req.user.id;

  // Get basic counts
  const [
    totalWebsites,
    activeWebsites,
    totalCrawls,
    recentCrawls,
    totalBrokenLinks,
    recentBrokenLinks
  ] = await Promise.all([
    Website.count({ where: { userId } }),
    Website.count({ where: { userId, isActive: true } }),
    CrawlResult.count({ where: { userId } }),
    CrawlResult.count({
      where: {
        userId,
        createdAt: {
          [Op.gte]: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) // Last 7 days
        }
      }
    }),
    BrokenLink.count({
      include: [{
        model: CrawlResult,
        as: 'crawlResult',
        where: { userId },
        attributes: []
      }]
    }),
    BrokenLink.count({
      where: {
        createdAt: {
          [Op.gte]: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
        }
      },
      include: [{
        model: CrawlResult,
        as: 'crawlResult',
        where: { userId },
        attributes: []
      }]
    })
  ]);

  // Get websites with health scores
  const websitesWithHealth = await Website.findAll({
    where: { userId },
    attributes: ['id', 'name', 'healthScore', 'totalLinks', 'brokenLinks'],
    order: [['healthScore', 'ASC']],
    limit: 5
  });

  // Get recent crawl activity
  const recentActivity = await CrawlResult.findAll({
    where: { userId },
    include: [{
      model: Website,
      as: 'website',
      attributes: ['name', 'url']
    }],
    order: [['createdAt', 'DESC']],
    limit: 10,
    attributes: ['id', 'status', 'brokenLinksFound', 'totalLinksChecked', 'createdAt']
  });

  // Calculate average health score
  const avgHealthScore = websitesWithHealth.length > 0
    ? websitesWithHealth.reduce((sum, site) => sum + parseFloat(site.healthScore), 0) / websitesWithHealth.length
    : 100;

  res.json({
    success: true,
    data: {
      overview: {
        totalWebsites,
        activeWebsites,
        totalCrawls,
        recentCrawls,
        totalBrokenLinks,
        recentBrokenLinks,
        averageHealthScore: Math.round(avgHealthScore * 100) / 100
      },
      topIssues: websitesWithHealth,
      recentActivity
    }
  });
}));

// @route   GET /api/dashboard/health-scores
// @desc    Get health scores for all websites
// @access  Private
router.get('/health-scores', asyncHandler(async (req, res) => {
  const websites = await Website.findAll({
    where: { userId: req.user.id },
    attributes: ['id', 'name', 'url', 'healthScore', 'totalLinks', 'brokenLinks', 'lastCrawledAt'],
    order: [['healthScore', 'ASC']]
  });

  // Categorize websites by health score
  const healthCategories = {
    critical: websites.filter(w => w.healthScore < 50),
    warning: websites.filter(w => w.healthScore >= 50 && w.healthScore < 80),
    good: websites.filter(w => w.healthScore >= 80 && w.healthScore < 95),
    excellent: websites.filter(w => w.healthScore >= 95)
  };

  res.json({
    success: true,
    data: {
      websites,
      categories: {
        critical: healthCategories.critical.length,
        warning: healthCategories.warning.length,
        good: healthCategories.good.length,
        excellent: healthCategories.excellent.length
      },
      breakdown: healthCategories
    }
  });
}));

// @route   GET /api/dashboard/broken-links-summary
// @desc    Get broken links summary by error type
// @access  Private
router.get('/broken-links-summary', asyncHandler(async (req, res) => {
  const brokenLinksSummary = await BrokenLink.findAll({
    include: [{
      model: CrawlResult,
      as: 'crawlResult',
      where: { userId: req.user.id },
      attributes: []
    }],
    attributes: [
      'errorType',
      [require('sequelize').fn('COUNT', require('sequelize').col('BrokenLink.id')), 'count']
    ],
    group: ['errorType'],
    order: [[require('sequelize').fn('COUNT', require('sequelize').col('BrokenLink.id')), 'DESC']]
  });

  // Get recent broken links
  const recentBrokenLinks = await BrokenLink.findAll({
    include: [{
      model: CrawlResult,
      as: 'crawlResult',
      where: { userId: req.user.id },
      attributes: [],
      include: [{
        model: Website,
        as: 'website',
        attributes: ['name', 'url']
      }]
    }],
    order: [['createdAt', 'DESC']],
    limit: 20,
    attributes: ['id', 'url', 'sourceUrl', 'errorType', 'statusCode', 'createdAt']
  });

  res.json({
    success: true,
    data: {
      summary: brokenLinksSummary.map(item => ({
        errorType: item.errorType,
        count: parseInt(item.dataValues.count)
      })),
      recentBrokenLinks
    }
  });
}));

// @route   GET /api/dashboard/crawl-performance
// @desc    Get crawl performance metrics
// @access  Private
router.get('/crawl-performance', [
  query('days').optional().isInt({ min: 7, max: 90 }).withMessage('Days must be between 7 and 90')
], checkValidation, asyncHandler(async (req, res) => {
  const days = parseInt(req.query.days) || 30;
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  // Get crawl performance data
  const performanceData = await CrawlResult.findAll({
    where: {
      userId: req.user.id,
      status: 'completed',
      createdAt: {
        [Op.gte]: startDate
      }
    },
    attributes: [
      [require('sequelize').fn('DATE', require('sequelize').col('createdAt')), 'date'],
      [require('sequelize').fn('AVG', require('sequelize').col('averageResponseTime')), 'avgResponseTime'],
      [require('sequelize').fn('AVG', require('sequelize').col('totalLinksChecked')), 'avgLinksChecked'],
      [require('sequelize').fn('AVG', require('sequelize').col('brokenLinksFound')), 'avgBrokenLinks'],
      [require('sequelize').fn('COUNT', require('sequelize').col('id')), 'crawlCount']
    ],
    group: [require('sequelize').fn('DATE', require('sequelize').col('createdAt'))],
    order: [[require('sequelize').fn('DATE', require('sequelize').col('createdAt')), 'ASC']]
  });

  // Get overall performance metrics
  const overallMetrics = await CrawlResult.findOne({
    where: {
      userId: req.user.id,
      status: 'completed',
      createdAt: {
        [Op.gte]: startDate
      }
    },
    attributes: [
      [require('sequelize').fn('AVG', require('sequelize').col('averageResponseTime')), 'avgResponseTime'],
      [require('sequelize').fn('MIN', require('sequelize').col('averageResponseTime')), 'minResponseTime'],
      [require('sequelize').fn('MAX', require('sequelize').col('averageResponseTime')), 'maxResponseTime'],
      [require('sequelize').fn('SUM', require('sequelize').col('totalLinksChecked')), 'totalLinksChecked'],
      [require('sequelize').fn('SUM', require('sequelize').col('brokenLinksFound')), 'totalBrokenLinks']
    ]
  });

  res.json({
    success: true,
    data: {
      performance: performanceData.map(item => ({
        date: item.dataValues.date,
        avgResponseTime: Math.round(parseFloat(item.dataValues.avgResponseTime) || 0),
        avgLinksChecked: Math.round(parseFloat(item.dataValues.avgLinksChecked) || 0),
        avgBrokenLinks: Math.round(parseFloat(item.dataValues.avgBrokenLinks) || 0),
        crawlCount: parseInt(item.dataValues.crawlCount)
      })),
      overall: {
        avgResponseTime: Math.round(parseFloat(overallMetrics?.dataValues?.avgResponseTime) || 0),
        minResponseTime: Math.round(parseFloat(overallMetrics?.dataValues?.minResponseTime) || 0),
        maxResponseTime: Math.round(parseFloat(overallMetrics?.dataValues?.maxResponseTime) || 0),
        totalLinksChecked: parseInt(overallMetrics?.dataValues?.totalLinksChecked) || 0,
        totalBrokenLinks: parseInt(overallMetrics?.dataValues?.totalBrokenLinks) || 0
      }
    }
  });
}));

// @route   GET /api/dashboard/website-categories
// @desc    Get website distribution by category
// @access  Private
router.get('/website-categories', asyncHandler(async (req, res) => {
  const categoryDistribution = await Website.findAll({
    where: { userId: req.user.id },
    attributes: [
      'category',
      [require('sequelize').fn('COUNT', require('sequelize').col('id')), 'count'],
      [require('sequelize').fn('AVG', require('sequelize').col('healthScore')), 'avgHealthScore'],
      [require('sequelize').fn('SUM', require('sequelize').col('brokenLinks')), 'totalBrokenLinks']
    ],
    group: ['category'],
    order: [[require('sequelize').fn('COUNT', require('sequelize').col('id')), 'DESC']]
  });

  res.json({
    success: true,
    data: {
      categories: categoryDistribution.map(item => ({
        category: item.category,
        count: parseInt(item.dataValues.count),
        avgHealthScore: Math.round(parseFloat(item.dataValues.avgHealthScore) * 100) / 100,
        totalBrokenLinks: parseInt(item.dataValues.totalBrokenLinks) || 0
      }))
    }
  });
}));

// @route   GET /api/dashboard/alerts
// @desc    Get dashboard alerts and notifications
// @access  Private
router.get('/alerts', asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const alerts = [];

  // Check for websites with critical health scores
  const criticalWebsites = await Website.findAll({
    where: {
      userId,
      healthScore: { [Op.lt]: 50 },
      isActive: true
    },
    attributes: ['id', 'name', 'healthScore', 'brokenLinks']
  });

  criticalWebsites.forEach(website => {
    alerts.push({
      type: 'critical',
      title: 'Critical Website Health',
      message: `${website.name} has a health score of ${website.healthScore}% with ${website.brokenLinks} broken links`,
      websiteId: website.id,
      severity: 'high',
      createdAt: new Date()
    });
  });

  // Check for websites that haven't been crawled recently
  const staleCrawlThreshold = new Date();
  staleCrawlThreshold.setDate(staleCrawlThreshold.getDate() - 14); // 14 days

  const staleWebsites = await Website.findAll({
    where: {
      userId,
      isActive: true,
      [Op.or]: [
        { lastCrawledAt: null },
        { lastCrawledAt: { [Op.lt]: staleCrawlThreshold } }
      ]
    },
    attributes: ['id', 'name', 'lastCrawledAt']
  });

  staleWebsites.forEach(website => {
    alerts.push({
      type: 'warning',
      title: 'Stale Website Data',
      message: `${website.name} hasn't been crawled in over 14 days`,
      websiteId: website.id,
      severity: 'medium',
      createdAt: new Date()
    });
  });

  // Check for recent failed crawls
  const recentFailedCrawls = await CrawlResult.findAll({
    where: {
      userId,
      status: 'failed',
      createdAt: {
        [Op.gte]: new Date(Date.now() - 24 * 60 * 60 * 1000) // Last 24 hours
      }
    },
    include: [{
      model: Website,
      as: 'website',
      attributes: ['name']
    }],
    attributes: ['id', 'websiteId', 'errorMessage', 'createdAt']
  });

  recentFailedCrawls.forEach(crawl => {
    alerts.push({
      type: 'error',
      title: 'Crawl Failed',
      message: `Failed to crawl ${crawl.website.name}: ${crawl.errorMessage}`,
      websiteId: crawl.websiteId,
      crawlId: crawl.id,
      severity: 'medium',
      createdAt: crawl.createdAt
    });
  });

  // Sort alerts by severity and date
  const severityOrder = { high: 3, medium: 2, low: 1 };
  alerts.sort((a, b) => {
    if (severityOrder[a.severity] !== severityOrder[b.severity]) {
      return severityOrder[b.severity] - severityOrder[a.severity];
    }
    return new Date(b.createdAt) - new Date(a.createdAt);
  });

  res.json({
    success: true,
    data: {
      alerts: alerts.slice(0, 20), // Limit to 20 most important alerts
      summary: {
        critical: alerts.filter(a => a.severity === 'high').length,
        warning: alerts.filter(a => a.severity === 'medium').length,
        info: alerts.filter(a => a.severity === 'low').length
      }
    }
  });
}));

module.exports = router;
