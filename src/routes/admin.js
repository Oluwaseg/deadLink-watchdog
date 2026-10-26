const express = require('express');
const { query, param } = require('express-validator');
const prisma = require('../lib/prisma');
const { excludePassword } = require('../utils/password');
const { QueueService } = require('../services/queue');
const { asyncHandler, AppError } = require('../middleware/errorHandler');
const { authenticateToken, requireAdmin } = require('../middleware/auth');

const router = express.Router();
const queueService = new QueueService();

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
          _count: {
            select: { websites: true },
          },
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
        users: users.map(({ _count, ...user }) => ({
          ...user,
          websiteCount: _count.websites,
        })),
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
