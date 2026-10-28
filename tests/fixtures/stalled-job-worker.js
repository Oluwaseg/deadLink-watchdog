const Bull = require('bull');

const queue = new Bull(process.env.TEST_BULL_QUEUE, {
  redis: {
    host: process.env.TEST_REDIS_HOST,
    port: Number(process.env.TEST_REDIS_PORT),
    password: process.env.TEST_REDIS_PASSWORD || undefined,
  },
  prefix: process.env.TEST_BULL_PREFIX,
  settings: { lockDuration: 1000, stalledInterval: 500, maxStalledCount: 1 },
});

queue.on('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});

queue.process('stalled-check', async () => {
  process.send?.('active');
  return new Promise(() => {});
});
