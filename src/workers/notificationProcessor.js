const { notificationQueue } = require('../services/queue');
const { requestPublicUrl } = require('../services/outboundUrlPolicy');

class NotificationProcessor {
  constructor() {
    this.isProcessing = false;
  }

  start() {
    console.log('Starting notification processor...');

    // Process webhook notifications only (emails are handled directly by email service)
    notificationQueue.process('send-webhook', 10, async (job) => {
      return await this.processWebhookJob(job);
    });

    // Set up event listeners
    notificationQueue.on('completed', (job, result) => {
      console.log(`Notification job ${job.id} completed successfully`);
    });

    notificationQueue.on('failed', (job, err) => {
      console.error(`Notification job ${job.id} failed:`, err.message);
    });

    notificationQueue.on('stalled', (job) => {
      console.warn(`Notification job ${job.id} stalled`);
    });

    this.isProcessing = true;
    console.log('Notification processor started successfully');
  }

  async stop() {
    console.log('Stopping notification processor...');
    this.isProcessing = false;
    console.log('Notification processor stopped');
  }

  async processWebhookJob(job) {
    const { url, data } = job.data;

    console.log(`Processing webhook job ${job.id} to ${url}`);

    try {
      job.progress(10);

      const response = await requestPublicUrl(url, {
        method: 'post',
        data,
        timeout: 10000,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'DeadLinkWatchdog/1.0',
        },
      });

      job.progress(100);

      console.log(`Webhook sent successfully to ${url}`);
      return {
        success: true,
        statusCode: response.status,
        response: response.data,
      };
    } catch (error) {
      console.error(`Webhook job ${job.id} failed:`, error);
      throw error;
    }
  }

  // Health check method
  isHealthy() {
    return this.isProcessing;
  }

  // Get processor statistics
  async getStats() {
    try {
      const [waiting, active, completed, failed] = await Promise.all([
        notificationQueue.getWaiting(),
        notificationQueue.getActive(),
        notificationQueue.getCompleted(),
        notificationQueue.getFailed(),
      ]);

      return {
        waiting: waiting.length,
        active: active.length,
        completed: completed.length,
        failed: failed.length,
        isProcessing: this.isProcessing,
      };
    } catch (error) {
      console.error('Failed to get notification processor stats:', error);
      return {
        waiting: 0,
        active: 0,
        completed: 0,
        failed: 0,
        isProcessing: this.isProcessing,
        error: error.message,
      };
    }
  }
}

module.exports = NotificationProcessor;
