require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const config = require('../config/config');
const db = require('./models');

// Import routes
const authRoutes = require('./routes/auth');
const websiteRoutes = require('./routes/websites');
const crawlRoutes = require('./routes/crawls');
const dashboardRoutes = require('./routes/dashboard');

// Import middleware
const { errorHandler } = require('./middleware/errorHandler');
const { authenticateToken } = require('./middleware/auth');

// Import services
const { QueueService } = require('./services/queue');
const CrawlProcessor = require('./workers/crawlProcessor');
const NotificationProcessor = require('./workers/notificationProcessor');
const SchedulerService = require('./services/scheduler');

class App {
  constructor() {
    this.app = express();
    this.queueService = new QueueService();
    this.crawlProcessor = new CrawlProcessor();
    this.notificationProcessor = new NotificationProcessor();
    this.schedulerService = new SchedulerService(this.queueService);

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
      this.app.use(morgan('combined'));
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
    this.app.use('/api/dashboard', authenticateToken, dashboardRoutes);

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
      // Stop accepting new connections
      if (this.server) {
        this.server.close(() => {
          console.log('HTTP server closed');
        });
      }

      // Stop workers and services
      await this.crawlProcessor.stop();
      await this.notificationProcessor.stop();
      await this.schedulerService.stop();
      await this.queueService.close();

      // Close database connections
      await db.sequelize.close();

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
      await db.sequelize.authenticate();
      console.log('Database connection established successfully');

      // Sync database (in development)
      if (config.nodeEnv === 'development') {
        await db.sequelize.sync({ alter: true });
        console.log('Database synchronized');
      }

      // Start the server
      this.server = this.app.listen(config.port, () => {
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
