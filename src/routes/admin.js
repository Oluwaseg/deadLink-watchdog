const express = require('express');
const { query, param } = require('express-validator');
const { User, Website, CrawlResult, BrokenLink } = require('../models');
const { QueueService } = require('../services/queue');
const { asyncHandler, AppError } = require('../middleware/errorHandler');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const { Op } = require('sequelize');

const router = express.Router();
const queueService = new QueueService();

/**
 * @swagger
 * components:
 *   schemas:
 *     Stats:
 *       type: object
 *       properties:
 *         totalUsers:
 *           type: integer
 *           description: Total number of users in the system
 *         totalWebsites:
 *           type: integer
 *           description: Total number of websites being monitored
 *         totalCrawls:
 *           type: integer
 *           description: Total number of crawls performed
 *         totalBrokenLinks:
 *           type: integer
 *           description: Total number of broken links found
 *         activeWebsites:
 *           type: integer
 *           description: Number of currently active websites
 *         recentUsers:
 *           type: array
 *           items:
 *             type: object
 *             properties:
 *               id:
 *                 type: string
 *               email:
 *                 type: string
 *               name:
 *                 type: string
 *               createdAt:
 *                 type: string
 *                 format: date-time
 */

/**
 * @swagger
 * /api/admin/stats:
 *   get:
 *     summary: Get system-wide statistics
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: System statistics retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   $ref: '#/components/schemas/Stats'
 *       401:
 *         description: Unauthorized - Invalid or missing token
 *       403:
 *         description: Forbidden - User is not an admin
 */
router.use(authenticateToken);
router.use(requireAdmin);

// @route   GET /api/admin/stats
// @desc    Get system-wide statistics
// @access  Admin
router.get(
  '/stats',
  asyncHandler(async (req, res) => {
    const [
      totalUsers,
      totalWebsites,
      totalCrawls,
      totalBrokenLinks,
      activeWebsites,
      recentUsers,
      queueStats
    ] = await Promise.all([
      User.count(),
      Website.count(),
      CrawlResult.count(),
      BrokenLink.count(),
      Website.count({ where: { isActive: true } }),
      User.findAll({
        limit: 5,
        order: [['createdAt', 'DESC']],
        attributes: ['id', 'email', 'name', 'createdAt']
      }),
      queueService.getQueueStats()
    ]);

    res.json({
      success: true,
      data: {
        totalUsers,
        totalWebsites,
        totalCrawls,
        totalBrokenLinks,
        activeWebsites,
        recentUsers,
        queueStats
      }
    });
  })
);

/**
 * @swagger
 * /api/admin/users:
 *   get:
 *     summary: Get all users with pagination and filtering
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           minimum: 1
 *         description: Page number
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *         description: Number of items per page
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *         description: Search term for email or name
 *       - in: query
 *         name: role
 *         schema:
 *           type: string
 *           enum: [user, admin]
 *         description: Filter by user role
 *       - in: query
 *         name: isActive
 *         schema:
 *           type: boolean
 *         description: Filter by user active status
 *     responses:
 *       200:
 *         description: List of users retrieved successfully
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
 *                     users:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           id:
 *                             type: string
 *                           email:
 *                             type: string
 *                           name:
 *                             type: string
 *                           role:
 *                             type: string
 *                           isActive:
 *                             type: boolean
 *                           createdAt:
 *                             type: string
 *                             format: date-time
 *                     pagination:
 *                       type: object
 *                       properties:
 *                         page:
 *                           type: integer
 *                         limit:
 *                           type: integer
 *                         total:
 *                           type: integer
 *                         pages:
 *                           type: integer
 */
router.get(
  '/users',
  [
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('search').optional().trim(),
    query('role').optional().isIn(['user', 'admin']),
    query('isActive').optional().isBoolean()
  ],
  asyncHandler(async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;
    
    const whereClause = {};
    if (req.query.search) {
      whereClause[Op.or] = [
        { email: { [Op.iLike]: `%${req.query.search}%` } },
        { name: { [Op.iLike]: `%${req.query.search}%` } }
      ];
    }
    if (req.query.role) whereClause.role = req.query.role;
    if (req.query.isActive !== undefined) {
      whereClause.isActive = req.query.isActive === 'true';
    }

    const { count, rows: users } = await User.findAndCountAll({
      where: whereClause,
      limit,
      offset,
      order: [['createdAt', 'DESC']],
      attributes: { exclude: ['password'] }
    });

    res.json({
      success: true,
      data: {
        users,
        pagination: {
          page,
          limit,
          total: count,
          pages: Math.ceil(count / limit)
        }
      }
    });
  })
);

// @route   PUT /api/admin/users/:id/status
// @desc    Update user status (activate/deactivate)
// @access  Admin
router.put(
  '/users/:id/status',
  [param('id').isUUID()],
  asyncHandler(async (req, res) => {
    const user = await User.findByPk(req.params.id);
    
    if (!user) {
      throw new AppError('User not found', 404, 'USER_NOT_FOUND');
    }

    if (user.role === 'admin' && user.id !== req.user.id) {
      throw new AppError('Cannot modify other admin users', 403, 'FORBIDDEN');
    }

    await user.update({ isActive: !user.isActive });

    res.json({
      success: true,
      message: `User ${user.isActive ? 'activated' : 'deactivated'} successfully`,
      data: { user }
    });
  })
);

/**
 * @swagger
 * /api/admin/users/{id}/role:
 *   put:
 *     summary: Update user role
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: User ID
 *       - in: query
 *         name: role
 *         required: true
 *         schema:
 *           type: string
 *           enum: [user, admin]
 *         description: New role for the user
 *     responses:
 *       200:
 *         description: User role updated successfully
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
 *                     user:
 *                       type: object
 *                       properties:
 *                         id:
 *                           type: string
 *                         email:
 *                           type: string
 *                         name:
 *                           type: string
 *                         role:
 *                           type: string
 *                         isActive:
 *                           type: boolean
 *                         createdAt:
 *                           type: string
 *                           format: date-time
 *       403:
 *         description: Forbidden - Cannot modify your own role
 *       404:
 *         description: Not Found - User not found
 */
router.put(
  '/users/:id/role',
  [
    param('id').isUUID(),
    query('role').isIn(['user', 'admin'])
  ],
  asyncHandler(async (req, res) => {
    if (req.params.id === req.user.id) {
      throw new AppError('Cannot modify your own role', 403, 'FORBIDDEN');
    }

    const user = await User.findByPk(req.params.id);
    
    if (!user) {
      throw new AppError('User not found', 404, 'USER_NOT_FOUND');
    }

    await user.update({ role: req.query.role });

    res.json({
      success: true,
      message: 'User role updated successfully',
      data: { user }
    });
  })
);

/**
 * @swagger
 * /api/admin/websites/moderation:
 *   get:
 *     summary: Get websites requiring moderation
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           minimum: 1
 *         description: Page number
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *         description: Number of items per page
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [flagged, reported, blocked]
 *         description: Filter by website status
 *     responses:
 *       200:
 *         description: List of websites requiring moderation
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
 *                     websites:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           id:
 *                             type: string
 *                           url:
 *                             type: string
 *                           isActive:
 *                             type: boolean
 *                           isFlagged:
 *                             type: boolean
 *                           reports:
 *                             type: integer
 *                           createdAt:
 *                             type: string
 *                             format: date-time
 *                     pagination:
 *                       type: object
 *                       properties:
 *                         page:
 *                           type: integer
 *                         limit:
 *                           type: integer
 *                         total:
 *                           type: integer
 *                         pages:
 *                           type: integer
 */
router.get(
  '/websites/moderation',
  [
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('status').optional().isIn(['flagged', 'reported', 'blocked'])
  ],
  asyncHandler(async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;

    const whereClause = {
      [Op.or]: [
        { isFlagged: true },
        { reports: { [Op.gt]: 0 } }
      ]
    };

    if (req.query.status === 'blocked') {
      whereClause.isActive = false;
    }

    const { count, rows: websites } = await Website.findAndCountAll({
      where: whereClause,
      limit,
      offset,
      order: [['reports', 'DESC'], ['createdAt', 'DESC']],
      include: [
        {
          model: User,
          as: 'user',
          attributes: ['id', 'email', 'name']
        }
      ]
    });

    res.json({
      success: true,
      data: {
        websites,
        pagination: {
          page,
          limit,
          total: count,
          pages: Math.ceil(count / limit)
        }
      }
    });
  })
);

/**
 * @swagger
 * /api/admin/websites/{id}/moderate:
 *   put:
 *     summary: Moderate a website (block/unblock)
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         description: Website ID
 *       - in: query
 *         name: action
 *         required: true
 *         schema:
 *           type: string
 *           enum: [block, unblock]
 *         description: Action to perform on the website
 *     responses:
 *       200:
 *         description: Website moderated successfully
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
 *                     website:
 *                       type: object
 *                       properties:
 *                         id:
 *                           type: string
 *                         url:
 *                           type: string
 *                         isActive:
 *                           type: boolean
 *                         isFlagged:
 *                           type: boolean
 *                         reports:
 *                           type: integer
 *                         createdAt:
 *                           type: string
 *                           format: date-time
 *       404:
 *         description: Not Found - Website not found
 */
router.put(
  '/websites/:id/moderate',
  [
    param('id').isUUID(),
    query('action').isIn(['block', 'unblock'])
  ],
  asyncHandler(async (req, res) => {
    const website = await Website.findByPk(req.params.id);
    
    if (!website) {
      throw new AppError('Website not found', 404, 'WEBSITE_NOT_FOUND');
    }

    await website.update({
      isActive: req.query.action === 'unblock',
      isFlagged: false,
      reports: 0,
      moderatedAt: new Date(),
      moderatedBy: req.user.id
    });

    res.json({
      success: true,
      message: `Website ${req.query.action}ed successfully`,
      data: { website }
    });
  })
);

/**
 * @swagger
 * /api/admin/queue:
 *   get:
 *     summary: Get queue statistics and jobs
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Queue statistics and jobs retrieved successfully
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
 *                     stats:
 *                       type: object
 *                       properties:
 *                         totalJobs:
 *                           type: integer
 *                         pending:
 *                           type: integer
 *                         active:
 *                           type: integer
 *                         completed:
 *                           type: integer
 *                         failed:
 *                           type: integer
 *                     jobs:
 *                       type: object
 *                       properties:
 *                         active:
 *                           type: array
 *                           items:
 *                             type: object
 *                             properties:
 *                               id:
 *                                 type: string
 *                               name:
 *                                 type: string
 *                               status:
 *                                 type: string
 *                               createdAt:
 *                                 type: string
 *                                 format: date-time
 *                         completed:
 *                           type: array
 *                           items:
 *                             type: object
 *                             properties:
 *                               id:
 *                                 type: string
 *                               name:
 *                                 type: string
 *                               status:
 *                                 type: string
 *                               createdAt:
 *                                 type: string
 *                                 format: date-time
 *                         failed:
 *                           type: array
 *                           items:
 *                             type: object
 *                             properties:
 *                               id:
 *                                 type: string
 *                               name:
 *                                 type: string
 *                               status:
 *                                 type: string
 *                               createdAt:
 *                                 type: string
 *                                 format: date-time
 */
router.get(
  '/queue',
  asyncHandler(async (req, res) => {
    const [queueStats, activeJobs, completedJobs, failedJobs] = await Promise.all([
      queueService.getQueueStats(),
      queueService.getActiveJobs(),
      queueService.getCompletedJobs(),
      queueService.getFailedJobs()
    ]);

    res.json({
      success: true,
      data: {
        stats: queueStats,
        jobs: {
          active: activeJobs,
          completed: completedJobs,
          failed: failedJobs
        }
      }
    });
  })
);

/**
 * @swagger
 * /api/admin/users/{userId}/status:
 *   put:
 *     summary: Update user active status
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: string
 *         description: ID of the user to update
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               isActive:
 *                 type: boolean
 *             required:
 *               - isActive
 *     responses:
 *       200:
 *         description: User status updated successfully
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 *       404:
 *         description: User not found
 */
router.put(
  '/users/:userId/status',
  param('userId').isUUID(),
  asyncHandler(async (req, res) => {
    const { userId } = req.params;
    const { isActive } = req.body;

    const user = await User.findByPk(userId);
    if (!user) {
      throw new AppError('User not found', 404);
    }

    await user.update({ isActive });

    res.json({
      success: true,
      message: 'User status updated successfully'
    });
  })
);

/**
 * @swagger
 * /api/admin/analytics/websites:
 *   get:
 *     summary: Get website analytics
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: period
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 365
 *         description: Period in days to analyze
 *     responses:
 *       200:
 *         description: Website analytics retrieved successfully
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
 *                     totalWebsites:
 *                       type: integer
 *                     newWebsites:
 *                       type: integer
 *                     activeWebsites:
 *                       type: integer
 *                     websitesByCategory:
 *                       type: object
 *                     crawlStats:
 *                       type: object
 */
router.get(
  '/analytics/websites',
  query('period').optional().isInt({ min: 1, max: 365 }),
  asyncHandler(async (req, res) => {
    const period = parseInt(req.query.period) || 30;
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - period);

    const [totalWebsites, newWebsites, websitesByCategory, crawlStats] = await Promise.all([
      Website.count(),
      Website.count({
        where: {
          createdAt: {
            [Op.gte]: startDate
          }
        }
      }),
      Website.count({
        group: ['category']
      }),
      CrawlResult.findAll({
        where: {
          createdAt: {
            [Op.gte]: startDate
          }
        },
        attributes: [
          [db.sequelize.fn('DATE', db.sequelize.col('createdAt')), 'date'],
          [db.sequelize.fn('COUNT', '*'), 'count']
        ],
        group: ['date'],
        order: [[db.sequelize.fn('DATE', db.sequelize.col('createdAt')), 'ASC']]
      })
    ]);

    res.json({
      success: true,
      data: {
        totalWebsites,
        newWebsites,
        websitesByCategory,
        crawlStats
      }
    });
  })
);

/**
 * @swagger
 * /api/admin/analytics/users:
 *   get:
 *     summary: Get user analytics
 *     tags: [Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: period
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 365
 *         description: Period in days to analyze
 *     responses:
 *       200:
 *         description: User analytics retrieved successfully
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
 *                     totalUsers:
 *                       type: integer
 *                     newUsers:
 *                       type: integer
 *                     activeUsers:
 *                       type: integer
 *                     userStats:
 *                       type: object
 */
router.get(
  '/analytics/users',
  query('period').optional().isInt({ min: 1, max: 365 }),
  asyncHandler(async (req, res) => {
    const period = parseInt(req.query.period) || 30;
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - period);

    const [totalUsers, newUsers, activeUsers, userStats] = await Promise.all([
      User.count(),
      User.count({
        where: {
          createdAt: {
            [Op.gte]: startDate
          }
        }
      }),
      User.count({
        where: {
          isActive: true
        }
      }),
      User.findAll({
        where: {
          createdAt: {
            [Op.gte]: startDate
          }
        },
        attributes: [
          [db.sequelize.fn('DATE', db.sequelize.col('createdAt')), 'date'],
          [db.sequelize.fn('COUNT', '*'), 'count']
        ],
        group: ['date'],
        order: [[db.sequelize.fn('DATE', db.sequelize.col('createdAt')), 'ASC']]
      })
    ]);

    res.json({
      success: true,
      data: {
        totalUsers,
        newUsers,
        activeUsers,
        userStats
      }
    });
  })
);

module.exports = router;