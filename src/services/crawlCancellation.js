class CrawlCancellationError extends Error {
  constructor(reason = 'cancelled', message) {
    super(
      message ||
        (reason === 'timeout' ? 'Crawl timed out.' : 'Crawl was cancelled.')
    );
    this.name = 'CrawlCancellationError';
    this.code = 'CRAWL_CANCELLED';
    this.reason = reason;
  }
}

class CrawlLeaseLostError extends Error {
  constructor(message = 'Crawl execution lease was lost.') {
    super(message);
    this.name = 'CrawlLeaseLostError';
    this.code = 'CRAWL_LEASE_LOST';
    this.reason = 'lease_lost';
  }
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new CrawlCancellationError('cancelled');
}

function abortableDelay(milliseconds, signal) {
  throwIfAborted(signal);
  if (milliseconds <= 0) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const timer = setTimeout(() => {
      finish();
      resolve();
    }, milliseconds);
    const onAbort = () => {
      finish();
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new CrawlCancellationError('cancelled')
      );
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function raceWithAbort(operation, signal) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      callback(value);
    };
    const onAbort = () =>
      finish(
        reject,
        signal.reason instanceof Error
          ? signal.reason
          : new CrawlCancellationError('cancelled')
      );

    signal?.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(operation).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error)
    );
  });
}

module.exports = {
  CrawlCancellationError,
  CrawlLeaseLostError,
  abortableDelay,
  raceWithAbort,
  throwIfAborted,
};
