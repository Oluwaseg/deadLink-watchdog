const express = require('express');
const { body, query, param, validationResult } = require('express-validator');
const prisma = require('../lib/prisma');
const { QueueService } = require('../services/queue');
const { asyncHandler, AppError } = require('../middleware/errorHandler');
const {
  toPrismaErrorType,
  fromPrismaErrorType,
} = require('../utils/errorType');

const router = express.Router();
const queueService = new QueueService();

// Validation middleware
const validateWebsite = [
  body('url')
    .isURL({ protocols: ['http', 'https'] })
    .withMessage('Please provide a valid URL'),
  body('name')
    .trim()
    .isLength({ min: 2, max: 100 })
    .withMessage('Name must be between 2 and 100 characters'),
  body('description')
    .optional()
    .trim()
    .isLength({ max: 500 })
    .withMessage('Description must not exceed 500 characters'),
  body('category')
    .optional()
    .isIn([
      'news',
      'government',
      'business',
      'education',
      'entertainment',
      'financial',
      'other',
    ])
    .withMessage('Invalid category'),
  body('crawlFrequency')
    .optional({ nullable: true })
    .if((value) => value !== null && value !== '')
    .isIn(['daily', 'weekly', 'monthly'])
    .withMessage('Invalid crawl frequency'),
  body('notificationEmail')
    .optional({ nullable: true })
    .if((value) => value !== null && value !== '')
    .isEmail()
    .normalizeEmail()
    .withMessage('Please provide a valid notification email'),
  body('webhookUrl')
    .optional({ nullable: true })
    .if((value) => value !== null && value !== '')
    .isURL()
    .withMessage('Please provide a valid webhook URL'),
];

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

const calculateNextCrawlTime = (frequency) => {
  const now = new Date();
  const nextCrawl = new Date(now);

  switch (frequency) {
    case 'daily':
      nextCrawl.setDate(now.getDate() + 1);
      break;
    case 'weekly':
      nextCrawl.setDate(now.getDate() + 7);
      break;
    case 'monthly':
      nextCrawl.setMonth(now.getMonth() + 1);
      break;
    default:
      nextCrawl.setDate(now.getDate() + 7);
  }

  nextCrawl.setHours(2, 0, 0, 0);
  return nextCrawl;
};

const mapBrokenLink = (link) => ({
  ...link,
  errorType: fromPrismaErrorType(link.errorType),
});

// @route   GET /api/websites
// @desc    Get all websites for the authenticated user
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
    query('category')
      .optional()
      .isIn([
        'news',
        'government',
        'business',
        'education',
        'entertainment',
        'financial',
        'other',
      ]),
    query('isActive').optional().isBoolean(),
  ],
  checkValidation,
  asyncHandler(async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    const where = { userId: req.user.id };

    if (req.query.category) {
      where.category = req.query.category;
    }

    if (req.query.isActive !== undefined) {
      where.isActive = req.query.isActive === 'true';
    }

    const [websites, count] = await Promise.all([
      prisma.website.findMany({
        where,
        take: limit,
        skip,
        orderBy: { createdAt: 'desc' },
        include: {
          crawlResults: {
            take: 1,
            orderBy: { createdAt: 'desc' },
          },
        },
      }),
      prisma.website.count({ where }),
    ]);

    res.json({
      success: true,
      data: {
        websites,
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

// @route   GET /api/websites/:id
// @desc    Get a specific website
// @access  Private
router.get(
  '/:id',
  [param('id').isUUID().withMessage('Website ID must be a valid UUID')],
  checkValidation,
  asyncHandler(async (req, res) => {
    const website = await prisma.website.findFirst({
      where: {
        id: req.params.id,
        userId: req.user.id,
      },
      include: {
        crawlResults: {
          take: 5,
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!website) {
      throw new AppError('Website not found', 404, 'WEBSITE_NOT_FOUND');
    }

    res.json({
      success: true,
      data: { website },
    });
  })
);

// @route   POST /api/websites
// @desc    Create a new website
// @access  Private
router.post(
  '/',
  validateWebsite,
  checkValidation,
  asyncHandler(async (req, res) => {
    const websiteData = {
      url: req.body.url,
      name: req.body.name,
      description: req.body.description || null,
      category: req.body.category || undefined,
      crawlFrequency: req.body.crawlFrequency || null,
      notificationEmail: req.body.notificationEmail || null,
      webhookUrl: req.body.webhookUrl || null,
      userId: req.user.id,
    };

    Object.keys(websiteData).forEach((key) => {
      if (websiteData[key] === '') {
        websiteData[key] = null;
      }
    });

    const existingWebsite = await prisma.website.findFirst({
      where: {
        url: req.body.url,
        userId: req.user.id,
      },
    });

    if (existingWebsite) {
      throw new AppError(
        'Website with this URL already exists',
        409,
        'WEBSITE_EXISTS'
      );
    }

    let website = await prisma.website.create({ data: websiteData });

    if (websiteData.crawlFrequency) {
      website = await prisma.website.update({
        where: { id: website.id },
        data: {
          nextCrawlAt: calculateNextCrawlTime(websiteData.crawlFrequency),
        },
      });
    }

    await queueService.addCrawlJob(website.id, req.user.id, {
      priority: 'high',
      scheduledBy: 'user',
    });

    res.status(201).json({
      success: true,
      message: 'Website created successfully',
      data: { website },
    });
  })
);

// @route   PUT /api/websites/:id
// @desc    Update a website
// @access  Private
router.put(
  '/:id',
  [param('id').isUUID().withMessage('Website ID must be a valid UUID')],
  validateWebsite,
  checkValidation,
  asyncHandler(async (req, res) => {
    const website = await prisma.website.findFirst({
      where: {
        id: req.params.id,
        userId: req.user.id,
      },
    });

    if (!website) {
      throw new AppError('Website not found', 404, 'WEBSITE_NOT_FOUND');
    }

    if (req.body.url && req.body.url !== website.url) {
      const existingWebsite = await prisma.website.findFirst({
        where: {
          url: req.body.url,
          userId: req.user.id,
          id: { not: req.params.id },
        },
      });

      if (existingWebsite) {
        throw new AppError(
          'Website with this URL already exists',
          409,
          'WEBSITE_EXISTS'
        );
      }
    }

    const updateData = {};
    const allowedFields = [
      'url',
      'name',
      'description',
      'category',
      'isActive',
      'crawlFrequency',
      'notificationEmail',
      'webhookUrl',
    ];

    for (const field of allowedFields) {
      if (field in req.body) {
        updateData[field] =
          req.body[field] === '' ? null : req.body[field];
      }
    }

    if ('crawlFrequency' in req.body) {
      if (!req.body.crawlFrequency) {
        updateData.crawlFrequency = null;
        updateData.nextCrawlAt = null;
      } else {
        updateData.nextCrawlAt = calculateNextCrawlTime(
          req.body.crawlFrequency
        );
      }
    }

    const updatedWebsite = await prisma.website.update({
      where: { id: website.id },
      data: updateData,
    });

    res.json({
      success: true,
      message: 'Website updated successfully',
      data: { website: updatedWebsite },
    });
  })
);

// @route   DELETE /api/websites/:id
// @desc    Delete a website
// @access  Private
router.delete(
  '/:id',
  [param('id').isUUID().withMessage('Website ID must be a valid UUID')],
  checkValidation,
  asyncHandler(async (req, res) => {
    const website = await prisma.website.findFirst({
      where: {
        id: req.params.id,
        userId: req.user.id,
      },
    });

    if (!website) {
      throw new AppError('Website not found', 404, 'WEBSITE_NOT_FOUND');
    }

    await queueService.removeRecurringCrawlJob(website.id);

    await prisma.brokenLink.deleteMany({
      where: { websiteId: website.id },
    });

    await prisma.crawlResult.deleteMany({
      where: { websiteId: website.id },
    });

    await prisma.website.delete({
      where: { id: website.id },
    });

    res.json({
      success: true,
      message: 'Website deleted successfully',
    });
  })
);

// @route   POST /api/websites/:id/crawl
// @desc    Trigger manual crawl for a website
// @access  Private
router.post(
  '/:id/crawl',
  [
    param('id').isUUID().withMessage('Website ID must be a valid UUID'),
    body('crawlDepth')
      .optional()
      .isInt({ min: 1, max: 3 })
      .withMessage('Crawl depth must be between 1 and 3'),
  ],
  checkValidation,
  asyncHandler(async (req, res) => {
    const website = await prisma.website.findFirst({
      where: {
        id: req.params.id,
        userId: req.user.id,
      },
    });

    if (!website) {
      throw new AppError('Website not found', 404, 'WEBSITE_NOT_FOUND');
    }

    if (!website.isActive) {
      throw new AppError('Website is not active', 400, 'WEBSITE_INACTIVE');
    }

    const job = await queueService.addCrawlJob(website.id, req.user.id, {
      crawlDepth: req.body.crawlDepth || 1,
      priority: 'high',
      scheduledBy: 'manual',
    });

    res.json({
      success: true,
      message: 'Crawl job queued successfully',
      data: {
        jobId: job.id,
        estimatedStartTime: new Date(Date.now() + 30000),
      },
    });
  })
);

// @route   GET /api/websites/:id/broken-links
// @desc    Get broken links for a website
// @access  Private
router.get(
  '/:id/broken-links',
  [
    param('id').isUUID().withMessage('Website ID must be a valid UUID'),
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
  ],
  checkValidation,
  asyncHandler(async (req, res) => {
    const website = await prisma.website.findFirst({
      where: {
        id: req.params.id,
        userId: req.user.id,
      },
    });

    if (!website) {
      throw new AppError('Website not found', 404, 'WEBSITE_NOT_FOUND');
    }

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const where = { websiteId: req.params.id };

    if (req.query.errorType) {
      where.errorType = toPrismaErrorType(req.query.errorType);
    }

    if (req.query.isFixed !== undefined) {
      where.isFixed = req.query.isFixed === 'true';
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

module.exports = router;
