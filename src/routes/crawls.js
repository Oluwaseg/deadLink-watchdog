const express = require('express');
const { query, param, validationResult } = require('express-validator');
const prisma = require('../lib/prisma');
const { QueueService } = require('../services/queue');
const { asyncHandler, AppError } = require('../middleware/errorHandler');
const {
  toPrismaErrorType,
  fromPrismaErrorType,
} = require('../utils/errorType');

const router = express.Router();
const queueService = new QueueService();

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

const mapBrokenLink = (link) => ({
  ...link,
  errorType: fromPrismaErrorType(link.errorType),
});

// @route   GET /api/crawls
// @desc    Get all crawl results for the authenticated user
// @access  Private
router.get(
  '/',
  [
    query('page')
      .optional()
      .isInt({ min: 1 })
      .withMessage('Page must be a positive integer'),
    query('limit')
      .optional()
      .isInt({ min: 1, max: 100 })
      .withMessage('Limit must be between 1 and 100'),
    query('status')
      .optional()
      .isIn(['pending', 'running', 'completed', 'failed']),
    query('websiteId')
      .optional()
      .isUUID()
      .withMessage('Website ID must be a valid UUID'),
  ],
  checkValidation,
  asyncHandler(async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    const where = { userId: req.user.id };

    if (req.query.status) {
      where.status = req.query.status;
    }

    if (req.query.websiteId) {
      where.websiteId = req.query.websiteId;
    }

    const [crawlResults, count] = await Promise.all([
      prisma.crawlResult.findMany({
        where,
        take: limit,
        skip,
        orderBy: { createdAt: 'desc' },
        include: {
          website: {
            select: { id: true, name: true, url: true, category: true },
          },
        },
      }),
      prisma.crawlResult.count({ where }),
    ]);

    res.json({
      success: true,
      data: {
        crawlResults,
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

// @route   GET /api/crawls/stats/summary
// @desc    Get crawl statistics summary for the user
// @access  Private
router.get(
  '/stats/summary',
  asyncHandler(async (req, res) => {
    const userId = req.user.id;

    const [
      totalCrawls,
      completedCrawls,
      failedCrawls,
      runningCrawls,
      totalBrokenLinks,
    ] = await Promise.all([
      prisma.crawlResult.count({ where: { userId } }),
      prisma.crawlResult.count({ where: { userId, status: 'completed' } }),
      prisma.crawlResult.count({ where: { userId, status: 'failed' } }),
      prisma.crawlResult.count({ where: { userId, status: 'running' } }),
      prisma.brokenLink.count({
        where: {
          crawlResult: { userId },
        },
      }),
    ]);

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const recentCrawls = await prisma.crawlResult.count({
      where: {
        userId,
        createdAt: { gte: thirtyDaysAgo },
      },
    });

    const avgResult = await prisma.crawlResult.aggregate({
      where: {
        userId,
        status: 'completed',
        createdAt: { gte: thirtyDaysAgo },
      },
      _avg: { averageResponseTime: true },
    });

    const averageResponseTime = avgResult._avg.averageResponseTime || 0;

    res.json({
      success: true,
      data: {
        summary: {
          totalCrawls,
          completedCrawls,
          failedCrawls,
          runningCrawls,
          totalBrokenLinks,
          recentCrawls,
          averageResponseTime: Math.round(averageResponseTime),
          successRate:
            totalCrawls > 0
              ? Math.round((completedCrawls / totalCrawls) * 100)
              : 0,
        },
      },
    });
  })
);

// @route   GET /api/crawls/stats/trends
// @desc    Get crawl trends data for charts
// @access  Private
router.get(
  '/stats/trends',
  [
    query('days')
      .optional()
      .isInt({ min: 7, max: 365 })
      .withMessage('Days must be between 7 and 365'),
  ],
  checkValidation,
  asyncHandler(async (req, res) => {
    const days = parseInt(req.query.days) || 30;
    const userId = req.user.id;

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const [dailyCrawls, brokenLinksTrend] = await Promise.all([
      prisma.$queryRaw`
        SELECT
          DATE("createdAt")::text AS date,
          COUNT(id)::int AS count,
          SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END)::int AS completed,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END)::int AS failed
        FROM crawl_results
        WHERE "userId" = ${userId}::uuid
          AND "createdAt" >= ${startDate}
        GROUP BY DATE("createdAt")
        ORDER BY DATE("createdAt") ASC
      `,
      prisma.$queryRaw`
        SELECT
          DATE(bl."createdAt")::text AS date,
          COUNT(bl.id)::int AS count
        FROM broken_links bl
        INNER JOIN crawl_results cr ON bl."crawlResultId" = cr.id
        WHERE cr."userId" = ${userId}::uuid
          AND bl."createdAt" >= ${startDate}
        GROUP BY DATE(bl."createdAt")
        ORDER BY DATE(bl."createdAt") ASC
      `,
    ]);

    res.json({
      success: true,
      data: {
        trends: {
          dailyCrawls: dailyCrawls.map((item) => ({
            date: item.date,
            total: Number(item.count),
            completed: Number(item.completed),
            failed: Number(item.failed),
          })),
          brokenLinks: brokenLinksTrend.map((item) => ({
            date: item.date,
            count: Number(item.count),
          })),
        },
      },
    });
  })
);

// @route   GET /api/crawls/:id
// @desc    Get a specific crawl result
// @access  Private
router.get(
  '/:id',
  [param('id').isUUID().withMessage('Crawl ID must be a valid UUID')],
  checkValidation,
  asyncHandler(async (req, res) => {
    const crawlResult = await prisma.crawlResult.findFirst({
      where: {
        id: req.params.id,
        userId: req.user.id,
      },
      include: {
        website: {
          select: { id: true, name: true, url: true, category: true },
        },
        brokenLinkRecords: {
          take: 50,
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!crawlResult) {
      throw new AppError(
        'Crawl result not found',
        404,
        'CRAWL_RESULT_NOT_FOUND'
      );
    }

    res.json({
      success: true,
      data: {
        crawlResult: {
          ...crawlResult,
          brokenLinkRecords: crawlResult.brokenLinkRecords.map(mapBrokenLink),
        },
      },
    });
  })
);

// @route   GET /api/crawls/:id/broken-links
// @desc    Get broken links for a specific crawl
// @access  Private
router.get(
  '/:id/broken-links',
  [
    param('id').isUUID().withMessage('Crawl ID must be a valid UUID'),
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
  ],
  checkValidation,
  asyncHandler(async (req, res) => {
    const crawlResult = await prisma.crawlResult.findFirst({
      where: {
        id: req.params.id,
        userId: req.user.id,
      },
      select: { id: true },
    });

    if (!crawlResult) {
      throw new AppError(
        'Crawl result not found',
        404,
        'CRAWL_RESULT_NOT_FOUND'
      );
    }

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const where = { crawlResultId: req.params.id };

    if (req.query.errorType) {
      where.errorType = toPrismaErrorType(req.query.errorType);
    }

    const [brokenLinks, count] = await Promise.all([
      prisma.brokenLink.findMany({
        where,
        take: limit,
        skip,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.brokenLink.count({ where }),
    ]);

    res.json({
      success: true,
      data: {
        brokenLinks: brokenLinks.map(mapBrokenLink),
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

// @route   POST /api/crawls/:id/retry
// @desc    Retry a failed crawl
// @access  Private
router.post(
  '/:id/retry',
  [param('id').isUUID().withMessage('Crawl ID must be a valid UUID')],
  checkValidation,
  asyncHandler(async (req, res) => {
    const crawlResult = await prisma.crawlResult.findFirst({
      where: {
        id: req.params.id,
        userId: req.user.id,
      },
      include: {
        website: {
          select: { id: true, isActive: true },
        },
      },
    });

    if (!crawlResult) {
      throw new AppError(
        'Crawl result not found',
        404,
        'CRAWL_RESULT_NOT_FOUND'
      );
    }

    if (crawlResult.status !== 'failed') {
      throw new AppError(
        'Only failed crawls can be retried',
        400,
        'CRAWL_NOT_FAILED'
      );
    }

    if (!crawlResult.website.isActive) {
      throw new AppError('Website is not active', 400, 'WEBSITE_INACTIVE');
    }

    const job = await queueService.addCrawlJob(
      crawlResult.websiteId,
      req.user.id,
      {
        crawlDepth: crawlResult.crawlDepth || 1,
        priority: 'high',
        scheduledBy: 'retry',
        crawlResultId: crawlResult.id,
      }
    );

    res.json({
      success: true,
      message: 'Crawl retry queued successfully',
      data: {
        jobId: job.id,
      },
    });
  })
);

module.exports = router;
