const express = require('express');
const { param, query, validationResult } = require('express-validator');
const prisma = require('../lib/prisma');
const { asyncHandler, AppError } = require('../middleware/errorHandler');

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
  '/',
  [query('limit').optional().isInt({ min: 1, max: 50 })],
  checkValidation,
  asyncHandler(async (req, res) => {
    const limit = Number.parseInt(req.query.limit, 10) || 20;
    const [notifications, unreadCount] = await Promise.all([
      prisma.notification.findMany({
        where: { userId: req.user.id },
        orderBy: { createdAt: 'desc' },
        take: limit,
      }),
      prisma.notification.count({
        where: { userId: req.user.id, readAt: null },
      }),
    ]);

    res.json({
      success: true,
      data: { notifications, unreadCount },
    });
  })
);

router.patch(
  '/read-all',
  asyncHandler(async (req, res) => {
    const result = await prisma.notification.updateMany({
      where: { userId: req.user.id, readAt: null },
      data: { readAt: new Date() },
    });

    res.json({ success: true, data: { updatedCount: result.count } });
  })
);

router.patch(
  '/:id/read',
  [param('id').isUUID()],
  checkValidation,
  asyncHandler(async (req, res) => {
    const notification = await prisma.notification.findFirst({
      where: { id: req.params.id, userId: req.user.id },
    });

    if (!notification) {
      throw new AppError(
        'Notification not found',
        404,
        'NOTIFICATION_NOT_FOUND'
      );
    }

    const updated = await prisma.notification.update({
      where: { id: notification.id },
      data: { readAt: notification.readAt || new Date() },
    });

    res.json({ success: true, data: { notification: updated } });
  })
);

module.exports = router;
