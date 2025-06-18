const Bull = require('bull');
const config = require('../config');

// Initialize queues
const crawlQueue = new Bull('crawl', config.redis.url);
const emailQueue = new Bull('email', config.redis.url);

/**
 * Get queue statistics
 * @returns {Promise<Object>} Queue statistics
 */
async function getStats() {
  const [crawlStats, emailStats] = await Promise.all([
    crawlQueue.getJobCounts(),
    emailQueue.getJobCounts()
  ]);

  return {
    waiting: crawlStats.waiting + emailStats.waiting,
    active: crawlStats.active + emailStats.active,
    completed: crawlStats.completed + emailStats.completed,
    failed: crawlStats.failed + emailStats.failed
  };
}

/**
 * Get active jobs from all queues
 * @returns {Promise<Array>} List of active jobs
 */
async function getActiveJobs() {
  const [crawlJobs, emailJobs] = await Promise.all([
    crawlQueue.getActive(),
    emailQueue.getActive()
  ]);

  return [
    ...crawlJobs.map(job => ({
      id: job.id,
      name: job.name,
      queue: 'crawl',
      data: job.data,
      progress: job.progress(),
      timestamp: job.timestamp
    })),
    ...emailJobs.map(job => ({
      id: job.id,
      name: job.name,
      queue: 'email',
      data: job.data,
      progress: job.progress(),
      timestamp: job.timestamp
    }))
  ];
}

module.exports = {
  crawlQueue,
  emailQueue,
  getStats,
  getActiveJobs
}; 