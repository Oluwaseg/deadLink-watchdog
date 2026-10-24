require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const config = require('../config/config');
const prisma = require('./lib/prisma');

// Import routes
const authRoutes = require('./routes/auth');
const websiteRoutes = require('./routes/websites');
const crawlRoutes = require('./routes/crawls');
const dashboardRoutes = require('./routes/dashboard');
const adminRoutes = require('./routes/admin');
const notificationRoutes = require('./routes/notifications');

// Import middleware
const { errorHandler } = require('./middleware/errorHandler');
const { authenticateToken } = require('./middleware/auth');

// Import services
const { QueueService } = require('./services/queue');
const CrawlProcessor = require('./workers/crawlProcessor');
const NotificationProcessor = require('./workers/notificationProcessor');
const SchedulerService = require('./services/scheduler');
const {
  attachRealtimeServer,
  closeRealtimeServer,
} = require('./services/realtime');

class App {
  constructor() {
    this.app = express();
    this.queueService = new QueueService();
    this.crawlProcessor = new CrawlProcessor();
    this.notificationProcessor = new NotificationProcessor();
    this.schedulerService = new SchedulerService(this.queueService);

    this.server = http.createServer(this.app);
    attachRealtimeServer(this.server, {
      jwtSecret: config.jwt.secret,
      prisma,
      origin: process.env.FRONTEND_URL || 'http://localhost:3000',
    });

    this.setupMiddleware();
    this.setupRoutes();
    this.setupErrorHandling();
    this.startWorkers().catch(console.error);
  }

  setupMiddleware() {
    // Security middleware
    this.app.use(helmet());

    // CORS configuration
    this.app.use(
      cors({
        origin: process.env.FRONTEND_URL || 'http://localhost:3000',
        credentials: true,
      })
    );

    // Rate limiting
    const limiter = rateLimit({
      windowMs: config.rateLimit.windowMs,
      max: config.rateLimit.maxRequests,
      message: {
        error: 'Too many requests from this IP, please try again later.',
      },
      standardHeaders: true,
      legacyHeaders: false,
    });
    this.app.use('/api/', limiter);

    // Body parsing middleware
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true, limit: '10mb' }));

    // Logging middleware
    if (config.nodeEnv !== 'test') {
      this.app.use(morgan('dev'));
    }

    // Request ID middleware
    this.app.use((req, res, next) => {
      req.id = Math.random().toString(36).substr(2, 9);
      res.setHeader('X-Request-ID', req.id);
      next();
    });
  }

  setupRoutes() {
    // Health check endpoint
    this.app.get('/health', (req, res) => {
      res.json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        environment: config.nodeEnv,
        version: process.env.npm_package_version || '1.0.0',
      });
    });

    // API routes
    this.app.use('/api/auth', authRoutes);
    this.app.use('/api/websites', authenticateToken, websiteRoutes);
    this.app.use('/api/crawls', authenticateToken, crawlRoutes);
    this.app.use('/api/notifications', authenticateToken, notificationRoutes);
    this.app.use('/api/dashboard', authenticateToken, dashboardRoutes);
    this.app.use('/api/admin', adminRoutes); // Admin routes already have auth middleware

    // Admin routes (queue management)
    this.app.get(
      '/api/admin/queue/stats',
      authenticateToken,
      async (req, res) => {
        try {
          if (req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Admin access required' });
          }

          const stats = await this.queueService.getQueueStats();
          res.json(stats);
        } catch (error) {
          res.status(500).json({ error: error.message });
        }
      }
    );

    // API documentation endpoint
    this.app.get('/api', (req, res) => {
      res.json({
        name: 'DeadLink Watchdog API',
        version: '1.0.0',
        description: 'API for monitoring broken links in Nigerian websites',
        endpoints: {
          auth: '/api/auth',
          websites: '/api/websites',
          crawls: '/api/crawls',
          dashboard: '/api/dashboard',
          health: '/health',
        },
        documentation: 'https://github.com/your-repo/deadlink-watchdog',
      });
    });

    // 404 handler for API routes
    this.app.use('/api/*', (req, res) => {
      res.status(404).json({
        error: 'API endpoint not found',
        path: req.path,
        method: req.method,
      });
    });

    // Root endpoint
    this.app.get('/', (req, res) => {
      res.json({
        message: 'Welcome to DeadLink Watchdog API',
        version: '1.0.0',
        documentation: '/api',
      });
    });
  }

  setupErrorHandling() {
    // Global error handler
    this.app.use(errorHandler);

    // Unhandled promise rejection handler
    process.on('unhandledRejection', (reason, promise) => {
      console.error('Unhandled Rejection at:', promise, 'reason:', reason);
      // Don't exit the process in production
      if (config.nodeEnv !== 'production') {
        process.exit(1);
      }
    });

    // Uncaught exception handler
    process.on('uncaughtException', (error) => {
      console.error('Uncaught Exception:', error);
      // Graceful shutdown
      this.gracefulShutdown();
    });

    // Graceful shutdown handlers
    process.on('SIGTERM', () => {
      console.log('SIGTERM received, shutting down gracefully');
      this.gracefulShutdown();
    });

    process.on('SIGINT', () => {
      console.log('SIGINT received, shutting down gracefully');
      this.gracefulShutdown();
    });
  }

  async startWorkers() {
    // Start queue processors
    await this.crawlProcessor.start();
    this.notificationProcessor.start();

    // Start scheduler
    this.schedulerService.start();

    console.log('Workers and scheduler started');
  }

  async gracefulShutdown() {
    console.log('Starting graceful shutdown...');

    try {
      // Socket.IO closes the shared HTTP listener when it shuts down.
      await closeRealtimeServer();

      // Stop workers and services
      await this.crawlProcessor.stop();
      await this.notificationProcessor.stop();
      await this.schedulerService.stop();
      await this.queueService.close();

      // Close database connections
      await prisma.$disconnect();

      console.log('Graceful shutdown completed');
      process.exit(0);
    } catch (error) {
      console.error('Error during graceful shutdown:', error);
      process.exit(1);
    }
  }

  async start() {
    try {
      // Test database connection
      await prisma.$connect();
      console.log('Database connection established successfully');

      // Start the server
      this.server.listen(config.port, () => {
        console.log(`
🚀 DeadLink Watchdog API Server Started
📍 Environment: ${config.nodeEnv}
🌐 Port: ${config.port}
📊 Health Check: http://localhost:${config.port}/health
📚 API Documentation: http://localhost:${config.port}/api
        `);
      });

      return this.server;
    } catch (error) {
      console.error('Failed to start server:', error);
      process.exit(1);
    }
  }
}

// Create and start the application
const app = new App();

// Start the server if this file is run directly
if (require.main === module) {
  app.start();
}

module.exports = app;
