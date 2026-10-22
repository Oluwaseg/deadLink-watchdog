const {
  PrismaClientKnownRequestError,
  PrismaClientValidationError,
  PrismaClientInitializationError,
} = require('@prisma/client/runtime/library');
const config = require('../../config/config');

const errorHandler = (err, req, res, next) => {
  let error = { ...err };
  error.message = err.message;

  // Log error
  console.error('Error:', {
    message: err.message,
    stack: err.stack,
    url: req.url,
    method: req.method,
    ip: req.ip,
    userAgent: req.get('User-Agent'),
    requestId: req.id
  });

  // Prisma validation error
  if (err instanceof PrismaClientValidationError) {
    error = {
      message: err.message,
      statusCode: 400,
      code: 'VALIDATION_ERROR'
    };
  }

  // Prisma known request errors
  if (err instanceof PrismaClientKnownRequestError) {
    // Unique constraint violation
    if (err.code === 'P2002') {
      const field = Array.isArray(err.meta?.target)
        ? err.meta.target[0]
        : err.meta?.target || 'field';
      error = {
        message: `${field} already exists`,
        statusCode: 409,
        code: 'DUPLICATE_ENTRY'
      };
    }

    // Foreign key constraint failure
    if (err.code === 'P2003') {
      error = {
        message: 'Referenced resource not found',
        statusCode: 400,
        code: 'FOREIGN_KEY_ERROR'
      };
    }

    // Record not found
    if (err.code === 'P2025') {
      error = {
        message: 'Resource not found',
        statusCode: 404,
        code: 'NOT_FOUND'
      };
    }
  }

  // Prisma database connection / initialization error
  if (err instanceof PrismaClientInitializationError) {
    error = {
      message: 'Database connection failed',
      statusCode: 500,
      code: 'DATABASE_ERROR'
    };
  }

  // JWT errors
  if (err.name === 'JsonWebTokenError') {
    error = {
      message: 'Invalid token',
      statusCode: 401,
      code: 'INVALID_TOKEN'
    };
  }

  if (err.name === 'TokenExpiredError') {
    error = {
      message: 'Token expired',
      statusCode: 401,
      code: 'TOKEN_EXPIRED'
    };
  }

  // Multer errors (file upload)
  if (err.code === 'LIMIT_FILE_SIZE') {
    error = {
      message: 'File too large',
      statusCode: 400,
      code: 'FILE_TOO_LARGE'
    };
  }

  // Cast error (invalid ObjectId)
  if (err.name === 'CastError') {
    error = {
      message: 'Invalid resource ID',
      statusCode: 400,
      code: 'INVALID_ID'
    };
  }

  // Default error
  const statusCode = error.statusCode || 500;
  const message = error.message || 'Internal Server Error';
  const code = error.code || 'INTERNAL_ERROR';

  // Prepare error response
  const errorResponse = {
    success: false,
    error: message,
    code,
    requestId: req.id,
    timestamp: new Date().toISOString()
  };

  // Add stack trace in development
  if (config.nodeEnv === 'development') {
    errorResponse.stack = err.stack;
  }

  // Add validation details if available
  if (err instanceof PrismaClientValidationError) {
    errorResponse.validationErrors = [{
      message: err.message
    }];
  }

  res.status(statusCode).json(errorResponse);
};

// Async error wrapper
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

// Custom error class
class AppError extends Error {
  constructor(message, statusCode, code = null) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = true;

    Error.captureStackTrace(this, this.constructor);
  }
}

module.exports = {
  errorHandler,
  asyncHandler,
  AppError
};
