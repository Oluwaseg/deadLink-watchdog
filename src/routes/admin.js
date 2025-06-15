const express = require('express');
const { query, param } = require('express-validator');
const { User, Website, CrawlResult, BrokenLink } = require('../models');
const { QueueService } = require('../services/queue');
const { asyncHandler, AppError } = require('../middleware/errorHandler');
const { authenticateToken, requireAdmin } = require('../middleware/auth');
const { Op } = require('sequelize');

const router = express.Router();
const queueService = new QueueService();

// Apply auth middleware to all admin routes
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

// @route   GET /api/admin/users
// @desc    Get all users with pagination and filtering
// @access  Admin
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

// @route   PUT /api/admin/users/:id/role
// @desc    Update user role
// @access  Admin
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

// @route   GET /api/admin/websites/moderation
// @desc    Get websites requiring moderation
// @access  Admin
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

// @route   PUT /api/admin/websites/:id/moderate
// @desc    Moderate a website (block/unblock)
// @access  Admin
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

// @route   GET /api/admin/queue
// @desc    Get queue statistics and jobs
// @access  Admin
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

module.exports = router;