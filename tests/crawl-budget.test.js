const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const Module = require('node:module');
const test = require('node:test');
const CrawlBudget = require('../src/services/crawlBudget');
const { CrawlCancellationError } = require('../src/services/crawlCancellation');
const outboundUrlPolicy = require('../src/services/outboundUrlPolicy');
const net = require('node:net');

const crawlerPath = require.resolve('../src/services/crawler');
const settings = {
  crawler: {
    executablePath: undefined,
    userAgent: 'crawl-budget-test',
    timeout: 1000,
    delay: 0,
    maxRetries: 1,
    retryDelay: 1,
    circuitBreakerTimeout: 1000,
    circuitBreakerThreshold: 3,
    cacheTimeout: 1000,
    rateLimitPerDomain: 100,
    maxLinksPerSite: 100,
    maxPagesPerCrawl: 100,
    maxNetworkRequestsPerCrawl: 100,
    maxConcurrent: 10,
    fastMode: false,
  },
};
let axiosRequest;
let browserRequestsByUrl;
let pageLinksByUrl;
let abortedBrowserRequests;
let activeFakePages;
let navigationCount;
let blockedNavigationUrl;
let navigationStarted;
let browserLaunchOptions;
let outboundRequest;
let blockedBrowserRequestCount;

class FakePage extends EventEmitter {
  constructor() {
    super();
    this.currentUrl = null;
    this.closed = false;
    activeFakePages.add(this);
  }

  async setUserAgent() {}
  async setRequestInterception() {}
  setDefaultTimeout() {}

  async goto(url) {
    this.currentUrl = url;
    navigationCount += 1;
    for (const requestUrl of browserRequestsByUrl.get(url) || [url]) {
      this.emit('request', {
        url: () => requestUrl,
        continue: async () => {},
        abort: async () => {
          abortedBrowserRequests += 1;
        },
      });
    }
    await new Promise((resolve) => setImmediate(resolve));
    if (url === blockedNavigationUrl) {
      navigationStarted?.();
      await new Promise((resolve, reject) => {
        this.rejectNavigation = reject;
      });
    }
  }

  async evaluate() {
    return pageLinksByUrl.get(this.currentUrl) || [];
  }

  async close() {
    this.closed = true;
    activeFakePages.delete(this);
    this.rejectNavigation?.(new Error('Page closed'));
  }
}

const fakePuppeteer = {
  launch: async (options) => {
    browserLaunchOptions = options;
    return { newPage: async () => new FakePage(), close: async () => {} };
  },
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (parent?.filename === crawlerPath) {
    if (request === 'puppeteer') return fakePuppeteer;
    if (request === 'axios') return (...args) => axiosRequest(...args);
    if (request === '../../config/config') return settings;
    if (request === './outboundProxy') {
      return () => ({
        listen: async () => 'http://127.0.0.1:12345',
        close: async () => {},
      });
    }
    if (request === './outboundUrlPolicy') {
      return {
        ...outboundUrlPolicy,
        resolveOutboundDestination: async (value) => {
          const parsed = outboundUrlPolicy.parseOutboundUrl(
            value.href || value
          );
          const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
          if (hostname === 'internal.example.invalid') {
            throw new outboundUrlPolicy.OutboundUrlError('prohibited address');
          }
          const family = net.isIP(hostname);
          if (family && !outboundUrlPolicy.isPublicAddress(hostname)) {
            throw new outboundUrlPolicy.OutboundUrlError('prohibited address');
          }
          return {
            url: parsed,
            hostname,
            address: family ? hostname : '93.184.216.34',
            family: family || 4,
            port:
              Number(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80),
          };
        },
        requestPublicUrl: async (url, options) => {
          options.beforeRequest?.(new URL(url), 0);
          return axiosRequest({
            ...options,
            url,
            beforeRedirect: () => options.beforeRequest?.(new URL(url), 1),
          });
        },
      };
    }
  }
  return originalLoad.call(this, request, parent, isMain);
};
const WebCrawler = require(crawlerPath);
Module._load = originalLoad;

function createCrawler() {
  browserRequestsByUrl = new Map();
  pageLinksByUrl = new Map();
  abortedBrowserRequests = 0;
  activeFakePages = new Set();
  navigationCount = 0;
  blockedNavigationUrl = null;
  navigationStarted = null;
  browserLaunchOptions = null;
  blockedBrowserRequestCount = 0;
  axiosRequest = async () => ({
    status: 200,
    headers: {},
  });
  outboundRequest = null;
  return new WebCrawler();
}

function link(url) {
  return {
    url,
    text: url,
    sourceUrl: 'https://budget.example/',
    type: 'anchor',
    element: 'a',
  };
}

test('page and request counters allow exact-limit work before marking truncation', () => {
  const budget = new CrawlBudget({ maxPages: 2, maxNetworkRequests: 2 });

  assert.equal(budget.reservePage('https://example.com/a').allowed, true);
  assert.equal(
    budget.reservePage('https://example.com/a#section').duplicate,
    true
  );
  assert.equal(budget.reservePage('https://example.com/b').allowed, true);
  assert.equal(budget.reserveNetworkRequest(), true);
  assert.equal(budget.reserveNetworkRequest(), true);
  assert.equal(budget.terminationReason, null);

  assert.equal(budget.reserveNetworkRequest(), false);
  assert.equal(budget.terminationReason, 'max_network_requests_reached');
  assert.deepEqual(budget.toJSON(), {
    maxPages: 2,
    maxNetworkRequests: 2,
    pagesProcessed: 2,
    networkRequests: 2,
    terminationReason: 'max_network_requests_reached',
  });
});

test('aborting an active Axios request prevents retries and propagates cancellation', async () => {
  const crawler = createCrawler();
  const controller = new AbortController();
  let requestCount = 0;
  axiosRequest = ({ signal }) => {
    requestCount += 1;
    return new Promise((resolve, reject) => {
      signal.addEventListener(
        'abort',
        () => reject(signal.reason || new Error('aborted')),
        { once: true }
      );
    });
  };

  const request = crawler.checkLink(
    'https://abort.example/resource',
    null,
    0,
    'anchor',
    null,
    controller.signal
  );
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort(new CrawlCancellationError('timeout'));

  await assert.rejects(request, (error) => error.reason === 'timeout');
  assert.equal(requestCount, 1);
});

test('cancellation during recursive navigation stops further discovery and closes owned pages', async () => {
  const crawler = createCrawler();
  const controller = new AbortController();
  const rootUrl = 'https://recursive-cancel.example/';
  const childUrl = `${rootUrl}child`;
  const grandchildUrl = `${rootUrl}grandchild`;
  browserRequestsByUrl.set(rootUrl, [rootUrl]);
  browserRequestsByUrl.set(childUrl, [childUrl]);
  pageLinksByUrl.set(rootUrl, [link(childUrl), link(grandchildUrl)]);
  blockedNavigationUrl = childUrl;
  const started = new Promise((resolve) => {
    navigationStarted = resolve;
  });

  const crawl = crawler.crawlWebsite(rootUrl, {
    depth: 3,
    signal: controller.signal,
  });
  await started;
  controller.abort(new CrawlCancellationError('cancelled'));

  await assert.rejects(crawl, (error) => error.reason === 'cancelled');
  assert.equal(navigationCount, 2);
  assert.equal(activeFakePages.size, 0);
});

test('timeout during recursive navigation closes pages and prevents later page requests', async () => {
  const crawler = createCrawler();
  const controller = new AbortController();
  const rootUrl = 'https://recursive-timeout.example/';
  const childUrl = `${rootUrl}child`;
  browserRequestsByUrl.set(rootUrl, [rootUrl]);
  browserRequestsByUrl.set(childUrl, [childUrl]);
  pageLinksByUrl.set(rootUrl, [link(childUrl), link(`${rootUrl}later`)]);
  blockedNavigationUrl = childUrl;
  const started = new Promise((resolve) => {
    navigationStarted = resolve;
  });

  const crawl = crawler.crawlWebsite(rootUrl, {
    depth: 3,
    signal: controller.signal,
  });
  await started;
  controller.abort(new CrawlCancellationError('timeout'));

  await assert.rejects(crawl, (error) => error.reason === 'timeout');
  assert.equal(navigationCount, 2);
  assert.equal(activeFakePages.size, 0);
});

test('parallel link checks reserve requests atomically and never exceed the crawl cap', async () => {
  const crawler = createCrawler();
  settings.crawler.maxConcurrent = 10;
  const budget = new CrawlBudget({ maxPages: 10, maxNetworkRequests: 3 });
  let requestsStarted = 0;
  axiosRequest = async () => {
    requestsStarted += 1;
    await new Promise((resolve) => setImmediate(resolve));
    return { status: 200, headers: {} };
  };

  const results = await crawler.checkMultipleLinks(
    Array.from({ length: 10 }, (_, index) =>
      link(`https://parallel.example/${index}`)
    ),
    null,
    budget
  );

  assert.equal(budget.networkRequests, 3);
  assert.equal(requestsStarted, 3);
  assert.equal(
    results.filter((result) => result.status === 'skipped').length,
    7
  );
  assert.equal(budget.terminationReason, 'max_network_requests_reached');
});

test('Puppeteer subresource requests are aborted at the network budget', async () => {
  const crawler = createCrawler();
  settings.crawler.maxPagesPerCrawl = 10;
  settings.crawler.maxNetworkRequestsPerCrawl = 2;
  const rootUrl = 'https://browser-budget.example/';
  browserRequestsByUrl.set(rootUrl, [
    rootUrl,
    `${rootUrl}one.js`,
    `${rootUrl}two.css`,
    `${rootUrl}three.png`,
  ]);
  pageLinksByUrl.set(rootUrl, [link(`${rootUrl}one`)]);
  let axiosCalls = 0;
  axiosRequest = async () => {
    axiosCalls += 1;
    return { status: 200, headers: {} };
  };

  const result = await crawler.crawlWebsite(rootUrl);

  assert.equal(result.budget.networkRequests, 2);
  assert.equal(result.terminationReason, 'max_network_requests_reached');
  assert.equal(abortedBrowserRequests, 2);
  assert.equal(axiosCalls, 0);
});

test('browser subresources resolving to internal addresses are aborted before continuation', async () => {
  const crawler = createCrawler();
  const rootUrl = 'https://browser-security.example/';
  browserRequestsByUrl.set(rootUrl, [
    rootUrl,
    'http://internal.example.invalid/metadata',
  ]);
  pageLinksByUrl.set(rootUrl, []);

  await crawler.crawlWebsite(rootUrl);

  assert.equal(abortedBrowserRequests, 1);
  assert.equal(browserLaunchOptions.args.includes('--disable-quic'), true);
  assert.equal(
    browserLaunchOptions.args.includes('--proxy-bypass-list=<-loopback>'),
    true
  );
  assert.equal(
    browserLaunchOptions.args.some((argument) =>
      argument.startsWith('--proxy-server=http://127.0.0.1:')
    ),
    true
  );
});

test('initial browser navigation rejects private IP literals before creating a page', async () => {
  const crawler = createCrawler();

  await assert.rejects(
    crawler.extractLinks('http://[::1]/private'),
    /prohibited address/
  );
  assert.equal(navigationCount, 0);
  assert.equal(activeFakePages.size, 0);
});

test('each new crawl starts with a fresh page and request budget', async () => {
  const crawler = createCrawler();
  settings.crawler.maxPagesPerCrawl = 2;
  settings.crawler.maxNetworkRequestsPerCrawl = 1;
  const firstUrl = 'https://reset-budget.example/first';
  const secondUrl = 'https://reset-budget.example/second';
  browserRequestsByUrl.set(firstUrl, [firstUrl]);
  browserRequestsByUrl.set(secondUrl, [secondUrl]);
  pageLinksByUrl.set(firstUrl, []);
  pageLinksByUrl.set(secondUrl, []);

  const firstCrawl = await crawler.crawlWebsite(firstUrl);
  const secondCrawl = await crawler.crawlWebsite(secondUrl);

  assert.equal(firstCrawl.budget.pagesProcessed, 1);
  assert.equal(firstCrawl.budget.networkRequests, 1);
  assert.equal(firstCrawl.terminationReason, null);
  assert.equal(secondCrawl.budget.pagesProcessed, 1);
  assert.equal(secondCrawl.budget.networkRequests, 1);
  assert.equal(secondCrawl.terminationReason, null);
});

test('redirect requests consume the same network budget as their initial request', async () => {
  const crawler = createCrawler();
  const budget = new CrawlBudget({ maxPages: 10, maxNetworkRequests: 2 });
  let redirectAttempts = 0;
  axiosRequest = async (options) => {
    options.beforeRedirect({}, { statusCode: 302 });
    redirectAttempts += 1;
    options.beforeRedirect({}, { statusCode: 301 });
    redirectAttempts += 1;
    return { status: 200, headers: {} };
  };

  const result = await crawler.checkLink(
    'https://redirect.example/start',
    null,
    0,
    'anchor',
    budget
  );

  assert.equal(redirectAttempts, 1);
  assert.equal(budget.networkRequests, 2);
  assert.equal(budget.terminationReason, 'max_network_requests_reached');
  assert.equal(result.status, 'skipped');
});

test('each transient retry consumes a request slot and stops before exceeding the cap', async () => {
  const crawler = createCrawler();
  const budget = new CrawlBudget({ maxPages: 10, maxNetworkRequests: 2 });
  let calls = 0;
  axiosRequest = async () => {
    calls += 1;
    if (calls === 1) {
      const error = new Error('connection reset');
      error.code = 'ECONNRESET';
      throw error;
    }
    return { status: 200, headers: {} };
  };

  const successfulRetry = await crawler.checkLink(
    'https://retry.example/allowed',
    null,
    0,
    'anchor',
    budget
  );
  assert.equal(successfulRetry.status, 'success');
  assert.equal(calls, 2);
  assert.equal(budget.networkRequests, 2);

  const cappedBudget = new CrawlBudget({ maxPages: 10, maxNetworkRequests: 1 });
  calls = 0;
  const stoppedRetry = await crawler.checkLink(
    'https://retry.example/capped',
    null,
    0,
    'anchor',
    cappedBudget
  );
  assert.equal(calls, 1);
  assert.equal(cappedBudget.networkRequests, 1);
  assert.equal(cappedBudget.terminationReason, 'max_network_requests_reached');
  assert.equal(stoppedRetry.status, 'skipped');
});

test('page budget is shared through depth traversal while respecting existing depth limit', async () => {
  const crawler = createCrawler();
  settings.crawler.maxPagesPerCrawl = 2;
  settings.crawler.maxNetworkRequestsPerCrawl = 100;
  const rootUrl = 'https://pages.example/';
  const firstUrl = 'https://pages.example/first';
  const secondUrl = 'https://pages.example/second';
  browserRequestsByUrl.set(rootUrl, [rootUrl, `${rootUrl}asset.js`]);
  browserRequestsByUrl.set(firstUrl, [firstUrl]);
  pageLinksByUrl.set(rootUrl, [link(firstUrl), link(secondUrl)]);
  pageLinksByUrl.set(firstUrl, [link(`${firstUrl}/child`)]);
  let checkedLinks = 0;
  axiosRequest = async () => {
    checkedLinks += 1;
    return { status: 200, headers: {} };
  };

  const result = await crawler.crawlWebsite(rootUrl, { depth: 2 });

  assert.equal(result.budget.pagesProcessed, 2);
  assert.equal(result.terminationReason, 'max_pages_reached');
  assert.equal(result.budget.networkRequests, 5);
  assert.equal(checkedLinks, 2);

  const depthOne = createCrawler();
  pageLinksByUrl.set(rootUrl, [link(firstUrl)]);
  const depthOneResult = await depthOne.crawlWebsite(rootUrl, { depth: 1 });
  assert.equal(depthOneResult.budget.pagesProcessed, 1);
  assert.equal(depthOneResult.terminationReason, null);
});
