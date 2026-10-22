const express = require('express');
const { query, param } = require('express-validator');
const prisma = require('../lib/prisma');
const { excludePassword } = require('../utils/password');
const { QueueService } = require('../services/queue');
const { asyncHandler, AppError } = require('../middleware/errorHandler');
const { authenticateToken, requireAdmin } = require('../middleware/auth');

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
 * tags:
 *   name: Admin
 *   description: Administrative endpoints for system management
 */

/**
 * @swagger
 * /api/admin/stats:
 *   get:
 *     tags: [Admin]
 *     summary: Get system-wide statistics
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
 *                   type: object
 *                   properties:
 *                     totalUsers:
 *                       type: integer
 *                     totalWebsites:
 *                       type: integer
 *                     totalCrawls:
 *                       type: integer
 *                     totalBrokenLinks:
 *                       type: integer
 *                     activeWebsites:
 *                       type: integer
 *                     recentUsers:
 *                       type: array
 *                       items:
 *                         type: object
 *                     queueStats:
 *                       type: object
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden - Admin access required
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
      queueStats,
    ] = await Promise.all([
      prisma.user.count(),
      prisma.website.count(),
      prisma.crawlResult.count(),
      prisma.brokenLink.count(),
      prisma.website.count({ where: { isActive: true } }),
      prisma.user.findMany({
        take: 5,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          createdAt: true,
        },
      }),
      queueService.getQueueStats(),
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
        queueStats,
      },
    });
  })
);

/**
 * @swagger
 * /api/admin/users:
 *   get:
 *     tags: [Admin]
 *     summary: Get all users with pagination and filtering
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
 *           default: 20
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
 *                           firstName:
 *                             type: string
 *                           lastName:
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
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden - Admin access required
 */
router.get(
  '/users',
  [
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('search').optional().trim(),
    query('role').optional().isIn(['user', 'admin']),
    query('isActive').optional().isBoolean(),
  ],
  asyncHandler(async (req, res) => {
    const { page = 1, limit = 20, search, role, isActive } = req.query;
    const skip = (page - 1) * limit;

    const where = {};
    if (search) {
      where.OR = [
        { email: { contains: search, mode: 'insensitive' } },
        { firstName: { contains: search, mode: 'insensitive' } },
        { lastName: { contains: search, mode: 'insensitive' } },
      ];
    }
    if (role) where.role = role;
    if (isActive !== undefined) where.isActive = isActive === 'true';

    const [users, count] = await Promise.all([
      prisma.user.findMany({
        where,
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          role: true,
          isActive: true,
          createdAt: true,
        },
        take: parseInt(limit),
        skip: parseInt(skip),
        orderBy: { createdAt: 'desc' },
      }),
      prisma.user.count({ where }),
    ]);

    res.json({
      success: true,
      data: {
        users,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: count,
          pages: Math.ceil(count / limit),
        },
      },
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
    const user = await prisma.user.findUnique({
      where: { id: req.params.id },
    });

    if (!user) {
      throw new AppError('User not found', 404, 'USER_NOT_FOUND');
    }

    if (user.role === 'admin' && user.id !== req.user.id) {
      throw new AppError('Cannot modify other admin users', 403, 'FORBIDDEN');
    }

    const updatedUser = await prisma.user.update({
      where: { id: user.id },
      data: { isActive: !user.isActive },
    });

    res.json({
      success: true,
      message: `User ${
        updatedUser.isActive ? 'activated' : 'deactivated'
      } successfully`,
      data: { user: excludePassword(updatedUser) },
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
  [param('id').isUUID(), query('role').isIn(['user', 'admin'])],
  asyncHandler(async (req, res) => {
    if (req.params.id === req.user.id) {
      throw new AppError('Cannot modify your own role', 403, 'FORBIDDEN');
    }

    const user = await prisma.user.findUnique({
      where: { id: req.params.id },
    });

    if (!user) {
      throw new AppError('User not found', 404, 'USER_NOT_FOUND');
    }

    const updatedUser = await prisma.user.update({
      where: { id: user.id },
      data: { role: req.query.role },
    });

    res.json({
      success: true,
      message: 'User role updated successfully',
      data: { user: excludePassword(updatedUser) },
    });
  })
);

/**
 * @swagger
 * /api/admin/websites/moderation:
 *   get:
 *     tags: [Admin]
 *     summary: Get websites pending moderation
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
 *           default: 20
 *         description: Number of items per page
 *     responses:
 *       200:
 *         description: List of websites pending moderation
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
 *                           name:
 *                             type: string
 *                           status:
 *                             type: string
 *                           user:
 *                             type: object
 *                             properties:
 *                               id:
 *                                 type: string
 *                               email:
 *                                 type: string
 *                               firstName:
 *                                 type: string
 *                               lastName:
 *                                 type: string
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
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden - Admin access required
 */
router.get(
  '/websites/moderation',
  [
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('status').optional().isIn(['flagged', 'reported', 'blocked']),
  ],
  asyncHandler(async (req, res) => {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const where = {
      OR: [{ isFlagged: true }, { reports: { gt: 0 } }],
    };

    if (req.query.status === 'blocked') {
      where.isActive = false;
    }

    const [websites, count] = await Promise.all([
      prisma.website.findMany({
        where,
        take: limit,
        skip,
        orderBy: [{ reports: 'desc' }, { createdAt: 'desc' }],
        include: {
          user: {
            select: {
              id: true,
              email: true,
              firstName: true,
              lastName: true,
            },
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
  [param('id').isUUID(), query('action').isIn(['block', 'unblock'])],
  asyncHandler(async (req, res) => {
    const website = await prisma.website.findUnique({
      where: { id: req.params.id },
    });

    if (!website) {
      throw new AppError('Website not found', 404, 'WEBSITE_NOT_FOUND');
    }

    const updatedWebsite = await prisma.website.update({
      where: { id: website.id },
      data: {
        isActive: req.query.action === 'unblock',
        isFlagged: false,
        reports: 0,
        moderatedAt: new Date(),
        moderatedBy: req.user.id,
      },
    });

    res.json({
      success: true,
      message: `Website ${req.query.action}ed successfully`,
      data: { website: updatedWebsite },
    });
  })
);

/**
 * @swagger
 * /api/admin/queue:
 *   get:
 *     tags: [Admin]
 *     summary: Get queue statistics and active jobs
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Queue statistics retrieved successfully
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
 *                         waiting:
 *                           type: integer
 *                         active:
 *                           type: integer
 *                         completed:
 *                           type: integer
 *                         failed:
 *                           type: integer
 *                     activeJobs:
 *                       type: array
 *                       items:
 *                         type: object
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden - Admin access required
 */
router.get(
  '/queue',
  asyncHandler(async (req, res) => {
    const stats = await queueService.getQueueStats();
    const activeJobs = await queueService.getActiveJobs();

    res.json({
      success: true,
      data: {
        stats,
        activeJobs,
      },
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

    const user = await prisma.user.findUnique({
      where: { id: userId },
    });
    if (!user) {
      throw new AppError('User not found', 404);
    }

    await prisma.user.update({
      where: { id: userId },
      data: { isActive },
    });

    res.json({
      success: true,
      message: 'User status updated successfully',
    });
  })
);

/**
 * @swagger
 * /api/admin/analytics/websites:
 *   get:
 *     tags: [Admin]
 *     summary: Get website analytics
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: period
 *         schema:
 *           type: integer
 *           default: 30
 *         description: Number of days to include in analytics
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
 *                     activeWebsites:
 *                       type: integer
 *                     websitesByCategory:
 *                       type: object
 *                     websitesByStatus:
 *                       type: object
 *                     newWebsites:
 *                       type: array
 *                       items:
 *                         type: object
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden - Admin access required
 */
router.get(
  '/analytics/websites',
  query('period').optional().isInt({ min: 1, max: 365 }),
  asyncHandler(async (req, res) => {
    try {
      const period = parseInt(req.query.period) || 30;
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - period);

      const [
        totalWebsites,
        activeWebsites,
        websitesByCategory,
        websitesByStatus,
        newWebsites,
      ] = await Promise.all([
        prisma.website.count(),
        prisma.website.count({ where: { isActive: true } }),
        prisma.website.groupBy({
          by: ['category'],
          _count: { id: true },
        }),
        prisma.website.groupBy({
          by: ['isActive'],
          _count: { id: true },
        }),
        prisma.website.findMany({
          where: {
            createdAt: { gte: startDate },
          },
          orderBy: { createdAt: 'desc' },
          take: 10,
        }),
      ]);

      res.json({
        success: true,
        data: {
          totalWebsites,
          activeWebsites,
          websitesByCategory: websitesByCategory.reduce((acc, curr) => {
            acc[curr.category] = curr._count.id;
            return acc;
          }, {}),
          websitesByStatus: websitesByStatus.reduce((acc, curr) => {
            acc[curr.isActive ? 'active' : 'inactive'] = curr._count.id;
            return acc;
          }, {}),
          newWebsites,
        },
      });
    } catch (error) {
      console.error('Error fetching website analytics:', error);
      res
        .status(500)
        .json({ success: false, message: 'Error fetching website analytics' });
    }
  })
);

/**
 * @swagger
 * /api/admin/analytics/users:
 *   get:
 *     tags: [Admin]
 *     summary: Get user analytics
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: period
 *         schema:
 *           type: integer
 *           default: 30
 *         description: Number of days to include in analytics
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
 *                     activeUsers:
 *                       type: integer
 *                     usersByRole:
 *                       type: object
 *                     newUsers:
 *                       type: array
 *                       items:
 *                         type: object
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden - Admin access required
 */
router.get(
  '/analytics/users',
  query('period').optional().isInt({ min: 1, max: 365 }),
  asyncHandler(async (req, res) => {
    try {
      const period = parseInt(req.query.period) || 30;
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - period);

      const [totalUsers, activeUsers, usersByRole, newUsers] =
        await Promise.all([
          prisma.user.count(),
          prisma.user.count({ where: { isActive: true } }),
          prisma.user.groupBy({
            by: ['role'],
            _count: { id: true },
          }),
          prisma.user.findMany({
            where: {
              createdAt: { gte: startDate },
            },
            select: {
              id: true,
              email: true,
              firstName: true,
              lastName: true,
              role: true,
              createdAt: true,
            },
            orderBy: { createdAt: 'desc' },
            take: 10,
          }),
        ]);

      res.json({
        success: true,
        data: {
          totalUsers,
          activeUsers,
          usersByRole: usersByRole.reduce((acc, curr) => {
            acc[curr.role] = curr._count.id;
            return acc;
          }, {}),
          newUsers,
        },
      });
    } catch (error) {
      console.error('Error fetching user analytics:', error);
      res
        .status(500)
        .json({ success: false, message: 'Error fetching user analytics' });
    }
  })
);

module.exports = router;
