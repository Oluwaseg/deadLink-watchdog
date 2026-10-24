const express = require('express');
const { body, validationResult } = require('express-validator');
const crypto = require('crypto');
const prisma = require('../lib/prisma');
const { hashPassword, validatePassword } = require('../utils/password');
const {
  generateTokens,
  verifyRefreshToken,
  authenticateToken,
} = require('../middleware/auth');
const { asyncHandler, AppError } = require('../middleware/errorHandler');
const emailService = require('../services/email');

const router = express.Router();

// Validation middleware
const validateRegistration = [
  body('email')
    .isEmail()
    .normalizeEmail()
    .withMessage('Please provide a valid email'),
  body('password')
    .isLength({ min: 6 })
    .withMessage('Password must be at least 6 characters long'),
  body('firstName')
    .trim()
    .isLength({ min: 2, max: 50 })
    .withMessage('First name must be between 2 and 50 characters'),
  body('lastName')
    .trim()
    .isLength({ min: 2, max: 50 })
    .withMessage('Last name must be between 2 and 50 characters'),
];

const validateLogin = [
  body('email')
    .isEmail()
    .normalizeEmail()
    .withMessage('Please provide a valid email'),
  body('password').notEmpty().withMessage('Password is required'),
];

// Helper function to check validation results
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

// @route   POST /api/auth/register
// @desc    Register a new user
// @access  Public
router.post(
  '/register',
  validateRegistration,
  checkValidation,
  asyncHandler(async (req, res) => {
    const { email, password, firstName, lastName } = req.body;

    // Check if user already exists
    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      throw new AppError(
        'User with this email already exists',
        409,
        'USER_EXISTS'
      );
    }

    // Generate email verification code
    const verificationCode = Math.floor(
      100000 + Math.random() * 900000
    ).toString();
    const verificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    // Create new user (not verified initially)
    const user = await prisma.user.create({
      data: {
        email,
        password: await hashPassword(password),
        firstName,
        lastName,
        emailVerified: false,
        emailVerificationCode: verificationCode,
        emailVerificationExpires: verificationExpires,
      },
    });

    // Send verification email
    try {
      await emailService.sendVerificationEmail(
        email,
        verificationCode,
        firstName
      );
    } catch (emailError) {
      console.error('Failed to send verification email:', emailError);
      // Don't fail registration if email fails
    }

    res.status(201).json({
      success: true,
      message:
        'User registered successfully. Please check your email for verification code.',
      data: {
        user: {
          id: user.id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          role: user.role,
          emailVerified: user.emailVerified,
        },
        requiresVerification: true,
      },
    });
  })
);

// @route   POST /api/auth/login
// @desc    Login user
// @access  Public
router.post(
  '/login',
  validateLogin,
  checkValidation,
  asyncHandler(async (req, res) => {
    const { email, password } = req.body;

    // Find user by email
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      throw new AppError('Invalid credentials', 401, 'INVALID_CREDENTIALS');
    }

    // Check if account is active
    if (!user.isActive) {
      throw new AppError('Account is deactivated', 401, 'ACCOUNT_DEACTIVATED');
    }

    // Check if email is verified
    if (!user.emailVerified) {
      throw new AppError(
        'Please verify your email before logging in',
        401,
        'EMAIL_NOT_VERIFIED'
      );
    }

    // Validate password
    const isValidPassword = await validatePassword(password, user.password);
    if (!isValidPassword) {
      throw new AppError('Invalid credentials', 401, 'INVALID_CREDENTIALS');
    }

    // Update last login
    const updatedUser = await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    // Generate tokens
    const { accessToken, refreshToken } = generateTokens(updatedUser);

    res.json({
      success: true,
      message: 'Login successful',
      data: {
        user: {
          id: updatedUser.id,
          email: updatedUser.email,
          firstName: updatedUser.firstName,
          lastName: updatedUser.lastName,
          role: updatedUser.role,
          emailVerified: updatedUser.emailVerified,
          lastLoginAt: updatedUser.lastLoginAt,
        },
        tokens: {
          accessToken,
          refreshToken,
        },
      },
    });
  })
);

// @route   POST /api/auth/verify-email
// @desc    Verify email with code
// @access  Public
router.post(
  '/verify-email',
  [
    body('email')
      .isEmail()
      .normalizeEmail()
      .withMessage('Please provide a valid email'),
    body('code')
      .isLength({ min: 6, max: 6 })
      .withMessage('Verification code must be 6 digits'),
  ],
  checkValidation,
  asyncHandler(async (req, res) => {
    const { email, code } = req.body;

    // Find user with matching email and verification code
    const user = await prisma.user.findFirst({
      where: {
        email,
        emailVerificationCode: code,
        emailVerificationExpires: {
          gt: new Date(),
        },
      },
    });

    if (!user) {
      throw new AppError(
        'Invalid or expired verification code',
        400,
        'INVALID_VERIFICATION_CODE'
      );
    }

    // Mark email as verified and clear verification fields
    const verifiedUser = await prisma.user.update({
      where: { id: user.id },
      data: {
        emailVerified: true,
        emailVerificationCode: null,
        emailVerificationExpires: null,
      },
    });

    // Send welcome email
    try {
      await emailService.sendWelcomeEmail(
        verifiedUser.email,
        verifiedUser.firstName
      );
    } catch (emailError) {
      console.error('Failed to send welcome email:', emailError);
      // Don't fail verification if welcome email fails
    }

    // Generate tokens for immediate login
    const { accessToken, refreshToken } = generateTokens(verifiedUser);

    res.json({
      success: true,
      message: 'Email verified successfully! Welcome to DeadLink Watchdog.',
      data: {
        user: {
          id: verifiedUser.id,
          email: verifiedUser.email,
          firstName: verifiedUser.firstName,
          lastName: verifiedUser.lastName,
          role: verifiedUser.role,
          emailVerified: verifiedUser.emailVerified,
        },
        tokens: {
          accessToken,
          refreshToken,
        },
      },
    });
  })
);

// @route   POST /api/auth/resend-verification
// @desc    Resend verification email
// @access  Public
router.post(
  '/resend-verification',
  [
    body('email')
      .isEmail()
      .normalizeEmail()
      .withMessage('Please provide a valid email'),
  ],
  checkValidation,
  asyncHandler(async (req, res) => {
    const { email } = req.body;

    // Find unverified user
    const user = await prisma.user.findFirst({
      where: {
        email,
        emailVerified: false,
      },
    });

    if (!user) {
      // Don't reveal if email exists for security
      return res.json({
        success: true,
        message:
          'If an unverified account exists, a new verification code has been sent.',
      });
    }

    // Generate new verification code
    const verificationCode = Math.floor(
      100000 + Math.random() * 900000
    ).toString();
    const verificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    // Update user with new code
    await prisma.user.update({
      where: { id: user.id },
      data: {
        emailVerificationCode: verificationCode,
        emailVerificationExpires: verificationExpires,
      },
    });

    // Send verification email
    try {
      await emailService.sendVerificationEmail(
        email,
        verificationCode,
        user.firstName
      );
    } catch (emailError) {
      console.error('Failed to send verification email:', emailError);
    }

    res.json({
      success: true,
      message:
        'If an unverified account exists, a new verification code has been sent.',
    });
  })
);

// @route   POST /api/auth/refresh
// @desc    Refresh access token
// @access  Public
router.post(
  '/refresh',
  asyncHandler(async (req, res) => {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      throw new AppError(
        'Refresh token required',
        400,
        'REFRESH_TOKEN_MISSING'
      );
    }

    try {
      // Verify refresh token
      const decoded = verifyRefreshToken(refreshToken);

      // Find user
      const user = await prisma.user.findUnique({
        where: { id: decoded.userId },
      });
      if (!user || !user.isActive) {
        throw new AppError(
          'Invalid refresh token',
          401,
          'INVALID_REFRESH_TOKEN'
        );
      }

      // Generate new tokens
      const { accessToken, refreshToken: newRefreshToken } =
        generateTokens(user);

      res.json({
        success: true,
        message: 'Token refreshed successfully',
        data: {
          tokens: {
            accessToken,
            refreshToken: newRefreshToken,
          },
        },
      });
    } catch (error) {
      throw new AppError('Invalid refresh token', 401, 'INVALID_REFRESH_TOKEN');
    }
  })
);

// @route   GET /api/auth/me
// @desc    Get current user profile
// @access  Private
router.get(
  '/me',
  authenticateToken,
  asyncHandler(async (req, res) => {
    res.json({
      success: true,
      data: {
        user: req.user,
      },
    });
  })
);

// @route   PUT /api/auth/profile
// @desc    Update user profile
// @access  Private
router.put(
  '/profile',
  authenticateToken,
  [
    body('firstName')
      .optional()
      .trim()
      .isLength({ min: 2, max: 50 })
      .withMessage('First name must be between 2 and 50 characters'),
    body('lastName')
      .optional()
      .trim()
      .isLength({ min: 2, max: 50 })
      .withMessage('Last name must be between 2 and 50 characters'),
    body('email')
      .optional()
      .isEmail()
      .normalizeEmail()
      .withMessage('Please provide a valid email'),
  ],
  checkValidation,
  asyncHandler(async (req, res) => {
    const { firstName, lastName, email } = req.body;
    const userId = req.user.id;

    // Check if email is already taken by another user
    if (email && email !== req.user.email) {
      const existingUser = await prisma.user.findUnique({
        where: { email },
        select: { id: true },
      });
      if (existingUser && existingUser.id !== userId) {
        throw new AppError('Email already in use', 409, 'EMAIL_IN_USE');
      }
    }

    // Update user
    const updateData = {};
    if (firstName) updateData.firstName = firstName;
    if (lastName) updateData.lastName = lastName;
    if (email) updateData.email = email;

    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: updateData,
      omit: { password: true },
    });

    res.json({
      success: true,
      message: 'Profile updated successfully',
      data: {
        user: updatedUser,
      },
    });
  })
);

// @route   PUT /api/auth/change-password
// @desc    Change user password
// @access  Private
router.put(
  '/change-password',
  authenticateToken,
  [
    body('currentPassword')
      .notEmpty()
      .withMessage('Current password is required'),
    body('newPassword')
      .isLength({ min: 6 })
      .withMessage('New password must be at least 6 characters long'),
  ],
  checkValidation,
  asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    const userId = req.user.id;

    // Get user with password
    const user = await prisma.user.findUnique({ where: { id: userId } });

    // Validate current password
    const isValidPassword = await validatePassword(
      currentPassword,
      user.password
    );
    if (!isValidPassword) {
      throw new AppError(
        'Current password is incorrect',
        400,
        'INVALID_CURRENT_PASSWORD'
      );
    }

    // Update password
    await prisma.user.update({
      where: { id: userId },
      data: { password: await hashPassword(newPassword) },
    });

    res.json({
      success: true,
      message: 'Password changed successfully',
    });
  })
);

// @route   POST /api/auth/forgot-password
// @desc    Send password reset email
// @access  Public
router.post(
  '/forgot-password',
  [
    body('email')
      .isEmail()
      .normalizeEmail()
      .withMessage('Please provide a valid email'),
  ],
  checkValidation,
  asyncHandler(async (req, res) => {
    const { email } = req.body;

    // Find user by email
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      // Don't reveal if email exists or not for security
      return res.json({
        success: true,
        message:
          'If an account with that email exists, a password reset link has been sent.',
      });
    }

    // Generate reset token
    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetTokenExpiry = new Date(Date.now() + 3600000); // 1 hour from now

    // Save reset token to user
    await prisma.user.update({
      where: { id: user.id },
      data: {
        resetPasswordToken: resetToken,
        resetPasswordExpires: resetTokenExpiry,
      },
    });

    // Send password reset email
    try {
      await emailService.sendPasswordResetEmail(
        email,
        resetToken,
        user.firstName
      );
    } catch (emailError) {
      console.error('Failed to send password reset email:', emailError);
      // Don't fail the request if email fails
    }

    res.json({
      success: true,
      message:
        'If an account with that email exists, a password reset link has been sent.',
      // Remove this in production - only for testing
      resetToken:
        process.env.NODE_ENV === 'development' ? resetToken : undefined,
    });
  })
);

// @route   POST /api/auth/reset-password
// @desc    Reset password using token
// @access  Public
router.post(
  '/reset-password',
  [
    body('token').notEmpty().withMessage('Reset token is required'),
    body('newPassword')
      .isLength({ min: 6 })
      .withMessage('New password must be at least 6 characters long'),
  ],
  checkValidation,
  asyncHandler(async (req, res) => {
    const { token, newPassword } = req.body;

    // Find user with valid reset token
    const user = await prisma.user.findFirst({
      where: {
        resetPasswordToken: token,
        resetPasswordExpires: {
          gt: new Date(),
        },
      },
    });

    if (!user) {
      throw new AppError(
        'Invalid or expired reset token',
        400,
        'INVALID_RESET_TOKEN'
      );
    }

    // Update password and clear reset token
    await prisma.user.update({
      where: { id: user.id },
      data: {
        password: await hashPassword(newPassword),
        resetPasswordToken: null,
        resetPasswordExpires: null,
      },
    });

    res.json({
      success: true,
      message: 'Password has been reset successfully',
    });
  })
);

module.exports = router;
