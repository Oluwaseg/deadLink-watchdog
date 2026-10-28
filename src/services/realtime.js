const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');

const CRAWL_STATUSES = new Set(['running', 'completed', 'failed']);

function createRealtimeServer(httpServer, { jwtSecret, prisma, origin }) {
  const io = new Server(httpServer, {
    cors: { origin, credentials: true },
  });

  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.accessToken;
      if (typeof token !== 'string' || !token) {
        const error = new Error('Authentication required');
        error.data = { code: 'TOKEN_MISSING' };
        return next(error);
      }

      const claims = jwt.verify(token, jwtSecret);
      if (
        claims.tokenUse !== 'access' ||
        typeof claims.userId !== 'string' ||
        !Number.isInteger(claims.exp)
      ) {
        const error = new Error('Invalid access token');
        error.data = { code: 'INVALID_TOKEN' };
        return next(error);
      }

      const user = await prisma.user.findUnique({
        where: { id: claims.userId },
        select: { id: true, isActive: true },
      });

      if (!user?.isActive) {
        const error = new Error('Account is unavailable');
        error.data = { code: 'ACCOUNT_UNAVAILABLE' };
        return next(error);
      }

      socket.data.userId = user.id;
      socket.data.tokenExpiresAt = claims.exp * 1000;
      next();
    } catch (error) {
      const authError = new Error(
        error.name === 'TokenExpiredError'
          ? 'Access token expired'
          : 'Invalid access token'
      );
      authError.data = {
        code:
          error.name === 'TokenExpiredError'
            ? 'TOKEN_EXPIRED'
            : 'INVALID_TOKEN',
      };
      next(authError);
    }
  });

  io.on('connection', (socket) => {
    socket.join(`user:${socket.data.userId}`);
    const expiresIn = Math.max(0, socket.data.tokenExpiresAt - Date.now());
    const expiryTimer = setTimeout(() => {
      socket.emit('auth:expired');
      socket.disconnect(true);
    }, expiresIn);
    expiryTimer.unref?.();
    socket.on('disconnect', () => clearTimeout(expiryTimer));
  });

  return {
    io,
    async publishCrawlEvent(event) {
      if (
        !event ||
        typeof event.crawlId !== 'string' ||
        typeof event.websiteId !== 'string' ||
        typeof event.userId !== 'string' ||
        !CRAWL_STATUSES.has(event.status) ||
        !Number.isInteger(event.progress) ||
        event.progress < 0 ||
        event.progress > 100
      ) {
        return false;
      }

      const crawl = await prisma.crawlResult.findFirst({
        where: { id: event.crawlId, userId: event.userId },
        select: { id: true, websiteId: true },
      });

      if (!crawl || crawl.websiteId !== event.websiteId) return false;

      if (event.status === 'completed') {
        if (
          typeof event.completedAt !== 'string' ||
          Number.isNaN(Date.parse(event.completedAt)) ||
          !Number.isInteger(event.totalLinksFound) ||
          event.totalLinksFound < 0 ||
          !Number.isInteger(event.totalLinksChecked) ||
          event.totalLinksChecked < 0 ||
          !Number.isInteger(event.brokenLinksFound) ||
          event.brokenLinksFound < 0
        ) {
          return false;
        }
      }

      if (
        event.status === 'failed' &&
        (typeof event.completedAt !== 'string' ||
          Number.isNaN(Date.parse(event.completedAt)) ||
          typeof event.errorMessage !== 'string')
      ) {
        return false;
      }

      let notification = null;
      let notificationCreated = false;
      if (event.status === 'completed' || event.status === 'failed') {
        const type =
          event.status === 'completed' ? 'crawl_completed' : 'crawl_failed';
        const title =
          event.status === 'completed' ? 'Crawl completed' : 'Crawl failed';
        const message =
          event.status === 'completed'
            ? `Website check finished with ${event.brokenLinksFound} broken link${event.brokenLinksFound === 1 ? '' : 's'}.`
            : `Website check failed: ${event.errorMessage.slice(0, 350)}`;

        const notificationData = {
          userId: event.userId,
          crawlId: event.crawlId,
          type,
          title,
          message,
        };

        try {
          notification = await prisma.notification.create({
            data: notificationData,
          });
          notificationCreated = true;
        } catch (error) {
          if (error.code !== 'P2002') throw error;
          notification = await prisma.notification.findUnique({
            where: {
              crawlId_type: { crawlId: event.crawlId, type },
            },
          });
        }
      }

      const payload = {
        crawlId: event.crawlId,
        websiteId: event.websiteId,
        status: event.status,
        progress: event.progress,
      };

      if (event.status === 'completed') {
        payload.completedAt = event.completedAt;
        payload.totalLinksFound = event.totalLinksFound;
        payload.totalLinksChecked = event.totalLinksChecked;
        payload.brokenLinksFound = event.brokenLinksFound;
      } else if (event.status === 'failed') {
        payload.completedAt = event.completedAt;
        payload.errorMessage = event.errorMessage.slice(0, 500);
      }

      const eventName =
        event.status === 'running'
          ? event.progress === 0
            ? 'crawl:started'
            : 'crawl:progress'
          : `crawl:${event.status}`;
      io.to(`user:${event.userId}`).emit(eventName, payload);
      if (notification && notificationCreated) {
        io.to(`user:${event.userId}`).emit('notification:new', notification);
      }
      return true;
    },
    close() {
      return new Promise((resolve) => io.close(resolve));
    },
  };
}

let realtimeServer = null;

function attachRealtimeServer(httpServer, options) {
  realtimeServer = createRealtimeServer(httpServer, options);
  return realtimeServer;
}

async function publishCrawlEvent(event) {
  if (!realtimeServer) return false;
  return realtimeServer.publishCrawlEvent(event);
}

async function closeRealtimeServer() {
  if (!realtimeServer) return;
  const current = realtimeServer;
  realtimeServer = null;
  await current.close();
}

module.exports = {
  attachRealtimeServer,
  closeRealtimeServer,
  createRealtimeServer,
  publishCrawlEvent,
};
