const express = require('express');
const { query, validationResult } = require('express-validator');
const prisma = require('../lib/prisma');
const { asyncHandler } = require('../middleware/errorHandler');
const {
  toPrismaErrorType,
  fromPrismaErrorType,
} = require('../utils/errorType');

const router = express.Router();

const checkValidation = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      error: 'Validation failed',
      code: 'VALIDATION_ERROR',
      details: errors.array(),
    });
  }
  next();
};

router.get(
  '/overview',
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const [
      totalWebsites,
      activeWebsites,
      totalCrawls,
      recentCrawls,
      totalBrokenLinks,
      recentBrokenLinks,
      websitesWithHealth,
      recentActivity,
    ] = await Promise.all([
      prisma.website.count({ where: { userId } }),
      prisma.website.count({ where: { userId, isActive: true } }),
      prisma.crawlResult.count({ where: { userId } }),
      prisma.crawlResult.count({
        where: { userId, createdAt: { gte: sevenDaysAgo } },
      }),
      prisma.brokenLink.count({ where: { crawlResult: { userId } } }),
      prisma.brokenLink.count({
        where: {
          createdAt: { gte: sevenDaysAgo },
          crawlResult: { userId },
        },
      }),
      prisma.website.findMany({
        where: { userId },
        select: {
          id: true,
          name: true,
          healthScore: true,
          totalLinks: true,
          brokenLinks: true,
        },
        orderBy: { healthScore: 'asc' },
        take: 5,
      }),
      prisma.crawlResult.findMany({
        where: { userId },
        select: {
          id: true,
          status: true,
          brokenLinksFound: true,
          totalLinksChecked: true,
          createdAt: true,
          website: { select: { name: true, url: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
    ]);

    const averageHealthScore = websitesWithHealth.length
      ? websitesWithHealth.reduce(
          (sum, site) => sum + Number(site.healthScore),
          0
        ) / websitesWithHealth.length
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
          averageHealthScore: Math.round(averageHealthScore * 100) / 100,
        },
        topIssues: websitesWithHealth,
        recentActivity,
      },
    });
  })
);

router.get(
  '/broken-links-summary',
  [
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('errorType')
      .optional()
      .isIn([
        '404_not_found',
        '403_forbidden',
        '500_server_error',
        'timeout',
        'connection_error',
        'connection_refused',
        'dns_error',
        'ssl_error',
        'redirect_loop',
        'too_many_redirects',
        'other',
      ]),
    query('isFixed').optional().isBoolean(),
    query('search').optional().isString().isLength({ max: 200 }),
  ],
  checkValidation,
  asyncHandler(async (req, res) => {
    const page = Number.parseInt(req.query.page, 10) || 1;
    const limit = Number.parseInt(req.query.limit, 10) || 20;
    const skip = (page - 1) * limit;
    const userId = req.user.id;

    const [summary, recentBrokenLinks, total] = await Promise.all([
      prisma.brokenLink.groupBy({
        by: ['errorType'],
        where: { crawlResult: { userId } },
        _count: { id: true },
        orderBy: { _count: { id: 'desc' } },
      }),
      prisma.brokenLink.findMany({
        where: {
          crawlResult: { userId },
          ...(req.query.errorType
            ? { errorType: toPrismaErrorType(req.query.errorType) }
            : {}),
          ...(req.query.isFixed !== undefined
            ? { isFixed: req.query.isFixed === 'true' }
            : {}),
          ...(req.query.search
            ? {
                OR: [
                  { url: { contains: req.query.search, mode: 'insensitive' } },
                  {
                    sourceUrl: {
                      contains: req.query.search,
                      mode: 'insensitive',
                    },
                  },
                ],
              }
            : {}),
        },
        select: {
          id: true,
          url: true,
          sourceUrl: true,
          errorType: true,
          statusCode: true,
          isFixed: true,
          fixedAt: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.brokenLink.count({
        where: {
          crawlResult: { userId },
          ...(req.query.errorType
            ? { errorType: toPrismaErrorType(req.query.errorType) }
            : {}),
          ...(req.query.isFixed !== undefined
            ? { isFixed: req.query.isFixed === 'true' }
            : {}),
          ...(req.query.search
            ? {
                OR: [
                  { url: { contains: req.query.search, mode: 'insensitive' } },
                  {
                    sourceUrl: {
                      contains: req.query.search,
                      mode: 'insensitive',
                    },
                  },
                ],
              }
            : {}),
        },
      }),
    ]);

    res.json({
      success: true,
      data: {
        summary: summary.map((item) => ({
          errorType: fromPrismaErrorType(item.errorType),
          count: item._count.id,
        })),
        recentBrokenLinks: recentBrokenLinks.map((link) => ({
          ...link,
          errorType: fromPrismaErrorType(link.errorType),
        })),
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      },
    });
  })
);

// @route   GET /api/dashboard/health-scores
// @desc    Get health scores for all websites
// @access  Private
router.get(
  '/health-scores',
  asyncHandler(async (req, res) => {
    const websites = await prisma.website.findMany({
      where: { userId: req.user.id },
      select: {
        id: true,
        name: true,
        url: true,
        healthScore: true,
        totalLinks: true,
        brokenLinks: true,
        lastCrawledAt: true,
      },
      orderBy: { healthScore: 'asc' },
    });

    const healthCategories = {
      critical: websites.filter((w) => parseFloat(w.healthScore) < 50),
      warning: websites.filter((w) => {
        const score = parseFloat(w.healthScore);
        return score >= 50 && score < 80;
      }),
      good: websites.filter((w) => {
        const score = parseFloat(w.healthScore);
        return score >= 80 && score < 95;
      }),
      excellent: websites.filter((w) => parseFloat(w.healthScore) >= 95),
    };

    res.json({
      success: true,
      data: {
        websites,
        categories: {
          critical: healthCategories.critical.length,
          warning: healthCategories.warning.length,
          good: healthCategories.good.length,
          excellent: healthCategories.excellent.length,
        },
        breakdown: healthCategories,
      },
    });
  })
);

// @route   GET /api/dashboard/broken-links-summary
// @desc    Get broken links summary by error type
// @access  Private
router.get(
  '/broken-links-summary',
  [
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('errorType')
      .optional()
      .isIn([
        '404_not_found',
        '403_forbidden',
        '500_server_error',
        'timeout',
        'connection_refused',
        'dns_error',
        'ssl_error',
        'redirect_loop',
        'too_many_redirects',
        'other',
      ]),
    query('isFixed').optional().isBoolean(),
    query('search').optional().isString().isLength({ max: 200 }),
  ],
  checkValidation,
  asyncHandler(async (req, res) => {
    const page = Number.parseInt(req.query.page, 10) || 1;
    const limit = Number.parseInt(req.query.limit, 10) || 20;
    const skip = (page - 1) * limit;

    const brokenLinksSummary = await prisma.brokenLink.groupBy({
      by: ['errorType'],
      where: { crawlResult: { userId: req.user.id } },
      _count: { id: true },
      orderBy: { _count: { id: 'desc' } },
    });

    const where = {
      crawlResult: { userId: req.user.id },
      ...(req.query.errorType
        ? { errorType: toPrismaErrorType(req.query.errorType) }
        : {}),
      ...(req.query.isFixed !== undefined
        ? { isFixed: req.query.isFixed === 'true' }
        : {}),
      ...(req.query.search
        ? {
            OR: [
              { url: { contains: req.query.search, mode: 'insensitive' } },
              {
                sourceUrl: { contains: req.query.search, mode: 'insensitive' },
              },
            ],
          }
        : {}),
    };

    const [recentBrokenLinks, count] = await Promise.all([
      prisma.brokenLink.findMany({
        where,
        select: {
          id: true,
          url: true,
          sourceUrl: true,
          errorType: true,
          statusCode: true,
          isFixed: true,
          fixedAt: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.brokenLink.count({ where }),
    ]);

    res.json({
      success: true,
      data: {
        summary: brokenLinksSummary.map((item) => ({
          errorType: item.errorType,
          count: item._count.id,
        })),
        recentBrokenLinks: recentBrokenLinks.map((link) => ({
          ...link,
          errorType: fromPrismaErrorType(link.errorType),
        })),
        pagination: {
          page,
          limit,
          total: count,
          pages: Math.ceil(count / limit),
        },
      },
    });
  })
);

// @route   GET /api/dashboard/crawl-performance
// @desc    Get crawl performance metrics
// @access  Private
router.get(
  '/crawl-performance',
  [
    query('days')
      .optional()
      .isInt({ min: 7, max: 90 })
      .withMessage('Days must be between 7 and 90'),
  ],
  checkValidation,
  asyncHandler(async (req, res) => {
    const days = parseInt(req.query.days) || 30;
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    const userId = req.user.id;

    const performanceData = await prisma.$queryRaw`
    SELECT DATE("createdAt") as date,
           AVG("averageResponseTime") as "avgResponseTime",
           AVG("totalLinksChecked") as "avgLinksChecked",
           AVG("brokenLinksFound") as "avgBrokenLinks",
           COUNT(id)::int as "crawlCount"
    FROM crawl_results
    WHERE "userId" = ${userId}::uuid
      AND status = 'completed'
      AND "createdAt" >= ${startDate}
    GROUP BY DATE("createdAt")
    ORDER BY date ASC
  `;

    const overallRows = await prisma.$queryRaw`
    SELECT AVG("averageResponseTime") as "avgResponseTime",
           MIN("averageResponseTime") as "minResponseTime",
           MAX("averageResponseTime") as "maxResponseTime",
           SUM("totalLinksChecked")::int as "totalLinksChecked",
           SUM("brokenLinksFound")::int as "totalBrokenLinks"
    FROM crawl_results
    WHERE "userId" = ${userId}::uuid
      AND status = 'completed'
      AND "createdAt" >= ${startDate}
  `;
    const overallMetrics = overallRows[0] || {};

    res.json({
      success: true,
      data: {
        performance: performanceData.map((item) => ({
          date: item.date,
          avgResponseTime: Math.round(parseFloat(item.avgResponseTime) || 0),
          avgLinksChecked: Math.round(parseFloat(item.avgLinksChecked) || 0),
          avgBrokenLinks: Math.round(parseFloat(item.avgBrokenLinks) || 0),
          crawlCount: parseInt(item.crawlCount),
        })),
        overall: {
          avgResponseTime: Math.round(
            parseFloat(overallMetrics.avgResponseTime) || 0
          ),
          minResponseTime: Math.round(
            parseFloat(overallMetrics.minResponseTime) || 0
          ),
          maxResponseTime: Math.round(
            parseFloat(overallMetrics.maxResponseTime) || 0
          ),
          totalLinksChecked: parseInt(overallMetrics.totalLinksChecked) || 0,
          totalBrokenLinks: parseInt(overallMetrics.totalBrokenLinks) || 0,
        },
      },
    });
  })
);

// @route   GET /api/dashboard/website-categories
// @desc    Get website distribution by category
// @access  Private
router.get(
  '/website-categories',
  asyncHandler(async (req, res) => {
    const categoryDistribution = await prisma.website.groupBy({
      by: ['category'],
      where: { userId: req.user.id },
      _count: { id: true },
      _avg: { healthScore: true },
      _sum: { brokenLinks: true },
      orderBy: {
        _count: { id: 'desc' },
      },
    });

    res.json({
      success: true,
      data: {
        categories: categoryDistribution.map((item) => ({
          category: item.category,
          count: item._count.id,
          avgHealthScore:
            Math.round(parseFloat(item._avg.healthScore || 0) * 100) / 100,
          totalBrokenLinks: item._sum.brokenLinks || 0,
        })),
      },
    });
  })
);

// @route   GET /api/dashboard/alerts
// @desc    Get dashboard alerts and notifications
// @access  Private
router.get(
  '/alerts',
  asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const alerts = [];

    const criticalWebsites = await prisma.website.findMany({
      where: {
        userId,
        healthScore: { lt: 50 },
        isActive: true,
      },
      select: {
        id: true,
        name: true,
        healthScore: true,
        brokenLinks: true,
      },
    });

    criticalWebsites.forEach((website) => {
      alerts.push({
        type: 'critical',
        title: 'Critical Website Health',
        message: `${website.name} has a health score of ${website.healthScore}% with ${website.brokenLinks} broken links`,
        websiteId: website.id,
        severity: 'high',
        createdAt: new Date(),
      });
    });

    const staleCrawlThreshold = new Date();
    staleCrawlThreshold.setDate(staleCrawlThreshold.getDate() - 14);

    const staleWebsites = await prisma.website.findMany({
      where: {
        userId,
        isActive: true,
        OR: [
          { lastCrawledAt: null },
          { lastCrawledAt: { lt: staleCrawlThreshold } },
        ],
      },
      select: {
        id: true,
        name: true,
        lastCrawledAt: true,
      },
    });

    staleWebsites.forEach((website) => {
      alerts.push({
        type: 'warning',
        title: 'Stale Website Data',
        message: `${website.name} hasn't been crawled in over 14 days`,
        websiteId: website.id,
        severity: 'medium',
        createdAt: new Date(),
      });
    });

    const recentFailedCrawls = await prisma.crawlResult.findMany({
      where: {
        userId,
        status: 'failed',
        createdAt: {
          gte: new Date(Date.now() - 24 * 60 * 60 * 1000),
        },
      },
      select: {
        id: true,
        websiteId: true,
        errorMessage: true,
        createdAt: true,
        website: {
          select: { name: true },
        },
      },
    });

    recentFailedCrawls.forEach((crawl) => {
      alerts.push({
        type: 'error',
        title: 'Crawl Failed',
        message: `Failed to crawl ${crawl.website.name}: ${crawl.errorMessage}`,
        websiteId: crawl.websiteId,
        crawlId: crawl.id,
        severity: 'medium',
        createdAt: crawl.createdAt,
      });
    });

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
        alerts: alerts.slice(0, 20),
        summary: {
          critical: alerts.filter((a) => a.severity === 'high').length,
          warning: alerts.filter((a) => a.severity === 'medium').length,
          info: alerts.filter((a) => a.severity === 'low').length,
        },
      },
    });
  })
);

module.exports = router;
