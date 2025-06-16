const express = require('express');
const { query, param, validationResult } = require('express-validator');
const { CrawlResult, Website, BrokenLink } = require('../models');
const { QueueService } = require('../services/queue');
const { asyncHandler, AppError } = require('../middleware/errorHandler');

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

/**
 * @swagger
 * tags:
 *   name: Crawls
 *   description: Website crawl management and results
 */

/**
 * @swagger
 * /api/crawls:
 *   get:
 *     tags: [Crawls]
 *     summary: Get all crawls with pagination and filtering
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *         description: Page number for pagination
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 10
 *         description: Number of items per page
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [pending, in_progress, completed, failed]
 *         description: Filter by crawl status
 *       - in: query
 *         name: websiteId
 *         schema:
 *           type: string
 *         description: Filter by website ID
 *     responses:
 *       200:
 *         description: List of crawls retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     crawls:
 *                       type: array
 *                       items:
 *                         type: object
 *                     total:
 *                       type: integer
 *                     page:
 *                       type: integer
 *                     totalPages:
 *                       type: integer
 *       401:
 *         description: Unauthorized
 */

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
    const offset = (page - 1) * limit;

    const whereClause = { userId: req.user.id };

    if (req.query.status) {
      whereClause.status = req.query.status;
    }

    if (req.query.websiteId) {
      whereClause.websiteId = req.query.websiteId;
    }

    const { count, rows: crawlResults } = await CrawlResult.findAndCountAll({
      where: whereClause,
      limit,
      offset,
      order: [['createdAt', 'DESC']],
      include: [
        {
          model: Website,
          as: 'website',
          attributes: ['id', 'name', 'url', 'category'],
        },
      ],
    });

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

/**
 * @swagger
 * /api/crawls/stats/summary:
 *   get:
 *     tags: [Crawls]
 *     summary: Get crawl statistics summary
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Crawl statistics retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     totalCrawls:
 *                       type: integer
 *                     completedCrawls:
 *                       type: integer
 *                     failedCrawls:
 *                       type: integer
 *                     averageResponseTime:
 *                       type: number
 *       401:
 *         description: Unauthorized
 */

// @route   GET /api/crawls/stats/summary
// @desc    Get crawl statistics summary for the user
// @access  Private
router.get(
  '/stats/summary',
  asyncHandler(async (req, res) => {
    const userId = req.user.id;

    // Get basic counts
    const [
      totalCrawls,
      completedCrawls,
      failedCrawls,
      runningCrawls,
      totalBrokenLinks,
    ] = await Promise.all([
      CrawlResult.count({ where: { userId } }),
      CrawlResult.count({ where: { userId, status: 'completed' } }),
      CrawlResult.count({ where: { userId, status: 'failed' } }),
      CrawlResult.count({ where: { userId, status: 'running' } }),
      BrokenLink.count({
        include: [
          {
            model: CrawlResult,
            as: 'crawlResult',
            where: { userId },
            attributes: [],
          },
        ],
      }),
    ]);

    // Get recent crawl activity (last 30 days)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const recentCrawls = await CrawlResult.count({
      where: {
        userId,
        createdAt: {
          [require('sequelize').Op.gte]: thirtyDaysAgo,
        },
      },
    });

    // Get average response time from recent completed crawls
    const avgResponseTimeResult = await CrawlResult.findOne({
      where: {
        userId,
        status: 'completed',
        createdAt: {
          [require('sequelize').Op.gte]: thirtyDaysAgo,
        },
      },
      attributes: [
        [
          require('sequelize').fn(
            'AVG',
            require('sequelize').col('averageResponseTime')
          ),
          'avgResponseTime',
        ],
      ],
    });

    const averageResponseTime =
      avgResponseTimeResult?.dataValues?.avgResponseTime || 0;

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

/**
 * @swagger
 * /api/crawls/stats/trends:
 *   get:
 *     tags: [Crawls]
 *     summary: Get crawl trends over time
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: days
 *         schema:
 *           type: integer
 *           default: 30
 *         description: Number of days to include in trend data
 *     responses:
 *       200:
 *         description: Crawl trends retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     trends:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           date:
 *                             type: string
 *                             format: date
 *                           completed:
 *                             type: integer
 *                           failed:
 *                             type: integer
 *       401:
 *         description: Unauthorized
 */

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

    // Get daily crawl counts
    const dailyCrawls = await CrawlResult.findAll({
      where: {
        userId,
        createdAt: {
          [require('sequelize').Op.gte]: startDate,
        },
      },
      attributes: [
        [
          require('sequelize').fn(
            'DATE',
            require('sequelize').col('createdAt')
          ),
          'date',
        ],
        [
          require('sequelize').fn('COUNT', require('sequelize').col('id')),
          'count',
        ],
        [
          require('sequelize').fn(
            'SUM',
            require('sequelize').literal(
              "CASE WHEN status = 'completed' THEN 1 ELSE 0 END"
            )
          ),
          'completed',
        ],
        [
          require('sequelize').fn(
            'SUM',
            require('sequelize').literal(
              "CASE WHEN status = 'failed' THEN 1 ELSE 0 END"
            )
          ),
          'failed',
        ],
      ],
      group: [
        require('sequelize').fn('DATE', require('sequelize').col('createdAt')),
      ],
      order: [
        [
          require('sequelize').fn(
            'DATE',
            require('sequelize').col('createdAt')
          ),
          'ASC',
        ],
      ],
    });

    // Get broken links trend
    const brokenLinksTrend = await BrokenLink.findAll({
      where: {
        createdAt: {
          [require('sequelize').Op.gte]: startDate,
        },
      },
      include: [
        {
          model: CrawlResult,
          as: 'crawlResult',
          where: { userId },
          attributes: [],
        },
      ],
      attributes: [
        [
          require('sequelize').fn(
            'DATE',
            require('sequelize').col('BrokenLink.createdAt')
          ),
          'date',
        ],
        [
          require('sequelize').fn(
            'COUNT',
            require('sequelize').col('BrokenLink.id')
          ),
          'count',
        ],
      ],
      group: [
        require('sequelize').fn(
          'DATE',
          require('sequelize').col('BrokenLink.createdAt')
        ),
      ],
      order: [
        [
          require('sequelize').fn(
            'DATE',
            require('sequelize').col('BrokenLink.createdAt')
          ),
          'ASC',
        ],
      ],
    });

    res.json({
      success: true,
      data: {
        trends: {
          dailyCrawls: dailyCrawls.map((item) => ({
            date: item.dataValues.date,
            total: parseInt(item.dataValues.count),
            completed: parseInt(item.dataValues.completed),
            failed: parseInt(item.dataValues.failed),
          })),
          brokenLinks: brokenLinksTrend.map((item) => ({
            date: item.dataValues.date,
            count: parseInt(item.dataValues.count),
          })),
        },
      },
    });
  })
);

/**
 * @swagger
 * /api/crawls/{id}:
 *   get:
 *     tags: [Crawls]
 *     summary: Get a specific crawl by ID
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Crawl ID
 *     responses:
 *       200:
 *         description: Crawl details retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     crawl:
 *                       type: object
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Crawl not found
 */

// @route   GET /api/crawls/:id
// @desc    Get a specific crawl result
// @access  Private
router.get(
  '/:id',
  [param('id').isUUID().withMessage('Crawl ID must be a valid UUID')],
  checkValidation,
  asyncHandler(async (req, res) => {
    const crawlResult = await CrawlResult.findOne({
      where: {
        id: req.params.id,
        userId: req.user.id,
      },
      include: [
        {
          model: Website,
          as: 'website',
          attributes: ['id', 'name', 'url', 'category'],
        },
        {
          model: BrokenLink,
          as: 'brokenLinkRecords',
          limit: 50,
          order: [['createdAt', 'DESC']],
        },
      ],
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
      data: { crawlResult },
    });
  })
);

/**
 * @swagger
 * /api/crawls/{id}/broken-links:
 *   get:
 *     tags: [Crawls]
 *     summary: Get broken links for a specific crawl
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Crawl ID
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *         description: Page number for pagination
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 10
 *         description: Number of items per page
 *       - in: query
 *         name: statusCode
 *         schema:
 *           type: integer
 *         description: Filter by HTTP status code
 *     responses:
 *       200:
 *         description: Broken links retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                   properties:
 *                     brokenLinks:
 *                       type: array
 *                       items:
 *                         type: object
 *                     total:
 *                       type: integer
 *                     page:
 *                       type: integer
 *                     totalPages:
 *                       type: integer
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Crawl not found
 */

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
    // First verify the crawl result belongs to the user
    const crawlResult = await CrawlResult.findOne({
      where: {
        id: req.params.id,
        userId: req.user.id,
      },
      attributes: ['id'],
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
    const offset = (page - 1) * limit;

    const whereClause = { crawlResultId: req.params.id };

    if (req.query.errorType) {
      whereClause.errorType = req.query.errorType;
    }

    const { count, rows: brokenLinks } = await BrokenLink.findAndCountAll({
      where: whereClause,
      limit,
      offset,
      order: [['createdAt', 'DESC']],
    });

    res.json({
      success: true,
      data: {
        brokenLinks,
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
    const crawlResult = await CrawlResult.findOne({
      where: {
        id: req.params.id,
        userId: req.user.id,
      },
      include: [
        {
          model: Website,
          as: 'website',
          attributes: ['id', 'isActive'],
        },
      ],
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

    // Add new crawl job to queue
    const job = await queueService.addCrawlJob(
      crawlResult.websiteId,
      req.user.id,
      {
        crawlDepth: crawlResult.crawlDepth || 1,
        priority: 'high',
        scheduledBy: 'retry',
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
