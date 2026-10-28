const puppeteer = require('puppeteer');
const { URL } = require('url');
const net = require('node:net');
const config = require('../../config/config');
const CrawlBudget = require('./crawlBudget');
const createOutboundProxy = require('./outboundProxy');
const {
  isPublicAddress,
  parseOutboundUrl,
  requestPublicUrl,
  resolveOutboundDestination,
} = require('./outboundUrlPolicy');
const {
  abortableDelay,
  raceWithAbort,
  throwIfAborted,
} = require('./crawlCancellation');

class CrawlBudgetExhaustedError extends Error {
  constructor(reason) {
    super(reason);
    this.code = 'CRAWL_BUDGET_EXHAUSTED';
    this.terminationReason = reason;
  }
}

const budgetReasonMessage = (reason) => {
  if (reason === 'max_pages_reached') {
    return `Crawl stopped after reaching the ${config.crawler.maxPagesPerCrawl}-page limit.`;
  }
  if (reason === 'max_network_requests_reached') {
    return `Crawl stopped after reaching the ${config.crawler.maxNetworkRequestsPerCrawl}-network-request limit.`;
  }
  return 'Crawl stopped after reaching a configured workload limit.';
};

class WebCrawler {
  constructor({
    resolver,
    validateAddress = isPublicAddress,
    browserExecutablePath,
  } = {}) {
    this.browser = null;
    this.outboundProxy = null;
    this.outboundProxyUrl = null;
    this.initializing = null;
    this.outboundResolver = resolver;
    this.outboundAddressValidator = validateAddress;
    this.browserExecutablePath = browserExecutablePath;
    this.userAgent = config.crawler.userAgent;
    this.timeout = config.crawler.timeout;
    this.delay = config.crawler.delay;
    this.maxRetries = config.crawler.maxRetries;
    this.retryDelay = config.crawler.retryDelay;
    this.circuitBreakerTimeout = config.crawler.circuitBreakerTimeout;
    this.circuitBreakerThreshold = config.crawler.circuitBreakerThreshold;
    this.cacheTimeout = config.crawler.cacheTimeout;
    this.rateLimitPerDomain = config.crawler.rateLimitPerDomain;
    this.maxLinksPerSite = config.crawler.maxLinksPerSite;
    this.fastMode = config.crawler.fastMode;
    this.circuitBreakers = new Map(); // Track circuit breaker state per domain
    this.requestCache = new Map(); // Simple in-memory cache for recent requests
    this.domainRateLimiters = new Map(); // Track rate limiting per domain
  }

  async initialize() {
    if (!this.browser) {
      if (!this.initializing) {
        this.initializing = (async () => {
          this.outboundProxy = createOutboundProxy({
            resolver: this.outboundResolver,
            validateAddress: this.outboundAddressValidator,
          });
          this.outboundProxyUrl = await this.outboundProxy.listen();
          try {
            this.browser = await puppeteer.launch({
              headless: true,
              ...(this.browserExecutablePath || config.crawler.executablePath
                ? {
                    executablePath:
                      this.browserExecutablePath ||
                      config.crawler.executablePath,
                  }
                : {}),
              args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu',
                '--disable-quic',
                '--dns-prefetch-disable',
                '--host-resolver-rules=MAP *.test ~NOTFOUND, EXCLUDE 127.0.0.1',
                '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
                `--proxy-server=${this.outboundProxyUrl}`,
                '--proxy-bypass-list=<-loopback>',
              ],
            });
          } catch (error) {
            await this.outboundProxy.close();
            this.outboundProxy = null;
            this.outboundProxyUrl = null;
            throw error;
          }
        })();
      }
      try {
        await this.initializing;
      } finally {
        this.initializing = null;
      }
    }
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
    if (this.outboundProxy) {
      await this.outboundProxy.close();
      this.outboundProxy = null;
      this.outboundProxyUrl = null;
    }
  }

  async extractLinks(url, depth = 1, budget = null, signal = null) {
    throwIfAborted(signal);
    const parsedUrl = parseOutboundUrl(url);
    const crawlBudget =
      budget ||
      new CrawlBudget({
        maxPages: config.crawler.maxPagesPerCrawl,
        maxNetworkRequests: config.crawler.maxNetworkRequestsPerCrawl,
      });
    const pageReservation = crawlBudget.reservePage(url);
    if (!pageReservation.allowed) {
      return { links: [], errors: [] };
    }
    await raceWithAbort(
      resolveOutboundDestination(
        parsedUrl,
        this.outboundResolver,
        this.outboundAddressValidator
      ),
      signal
    );

    await raceWithAbort(this.initialize(), signal);
    throwIfAborted(signal);

    const pagePromise = this.browser.newPage();
    let page;
    try {
      page = await raceWithAbort(pagePromise, signal);
    } catch (error) {
      pagePromise.then((latePage) => latePage.close()).catch(() => {});
      throw error;
    }
    const closePageOnAbort = () => {
      page.close().catch(() => {});
    };
    signal?.addEventListener('abort', closePageOnAbort, { once: true });
    const links = new Set();
    const errors = [];

    try {
      throwIfAborted(signal);
      await page.setUserAgent(this.userAgent);
      await page.setRequestInterception(true);
      page.on('request', (request) => {
        void (async () => {
          try {
            if (request.isInterceptResolutionHandled?.()) return;
            throwIfAborted(signal);
            const requestUrl = new URL(request.url());
            if (['data:', 'blob:', 'about:'].includes(requestUrl.protocol)) {
              await request.continue();
              return;
            }
            parseOutboundUrl(requestUrl.href);
            if (!crawlBudget.reserveNetworkRequest()) {
              await request.abort('blockedbyclient');
              return;
            }
            await raceWithAbort(
              resolveOutboundDestination(
                requestUrl,
                this.outboundResolver,
                this.outboundAddressValidator
              ),
              signal
            );
            throwIfAborted(signal);
            if (!request.isInterceptResolutionHandled?.()) {
              await request.continue();
            }
          } catch {
            if (!request.isInterceptResolutionHandled?.()) {
              await request.abort('blockedbyclient').catch(() => {});
            }
          }
        })();
      });

      // Set a shorter timeout for page operations
      page.setDefaultTimeout(this.timeout);

      console.log(`Extracting links from: ${url}`);

      // Navigate to the page with a more lenient wait condition
      await raceWithAbort(
        page.goto(parsedUrl.href, {
          waitUntil: 'domcontentloaded', // Changed from 'networkidle2' to be faster
          timeout: this.timeout,
        }),
        signal
      );
      throwIfAborted(signal);

      console.log(`Successfully loaded page: ${url}`);

      // Extract all links from the page (enhanced extraction)
      const pageLinks = await page.evaluate(() => {
        const links = [];

        // 1. Extract anchor links
        const anchors = Array.from(document.querySelectorAll('a[href]'));
        anchors.forEach((anchor) => {
          links.push({
            url: anchor.href,
            text: anchor.textContent.trim(),
            sourceUrl: window.location.href,
            type: 'anchor',
            element: 'a',
          });
        });

        // 2. Extract image src attributes
        const images = Array.from(document.querySelectorAll('img[src]'));
        images.forEach((img) => {
          links.push({
            url: img.src,
            text: img.alt || img.title || 'image',
            sourceUrl: window.location.href,
            type: 'image',
            element: 'img',
          });
        });

        // 3. Extract CSS background-image URLs
        const elementsWithBg = Array.from(document.querySelectorAll('*'));
        elementsWithBg.forEach((element) => {
          const style = window.getComputedStyle(element);
          const bgImage = style.backgroundImage;
          if (bgImage && bgImage !== 'none' && bgImage.includes('url(')) {
            const urlMatch = bgImage.match(/url\(['"]?([^'"]+)['"]?\)/);
            if (urlMatch && urlMatch[1]) {
              let url = urlMatch[1];
              // Convert relative URLs to absolute
              if (url.startsWith('/')) {
                url = window.location.origin + url;
              } else if (!url.startsWith('http')) {
                url = new URL(url, window.location.href).href;
              }

              links.push({
                url: url,
                text: `background-image in ${element.tagName.toLowerCase()}`,
                sourceUrl: window.location.href,
                type: 'background-image',
                element: element.tagName.toLowerCase(),
              });
            }
          }
        });

        // 4. Extract form action URLs
        const forms = Array.from(document.querySelectorAll('form[action]'));
        forms.forEach((form) => {
          links.push({
            url: form.action,
            text: `form action in ${form.tagName.toLowerCase()}`,
            sourceUrl: window.location.href,
            type: 'form-action',
            element: 'form',
          });
        });

        // 5. Extract link elements (CSS, favicon, etc.)
        const linkElements = Array.from(
          document.querySelectorAll('link[href]')
        );
        linkElements.forEach((link) => {
          links.push({
            url: link.href,
            text: link.rel || 'link element',
            sourceUrl: window.location.href,
            type: 'link-element',
            element: 'link',
          });
        });

        // 6. Extract script src attributes
        const scripts = Array.from(document.querySelectorAll('script[src]'));
        scripts.forEach((script) => {
          links.push({
            url: script.src,
            text: 'script source',
            sourceUrl: window.location.href,
            type: 'script',
            element: 'script',
          });
        });

        return links;
      });
      throwIfAborted(signal);

      console.log(`Found ${pageLinks.length} links on page: ${url}`);

      // Process each link with smart filtering
      let processedCount = 0;
      for (const link of pageLinks) {
        // Limit links per site in fast mode
        if (this.fastMode && processedCount >= this.maxLinksPerSite) {
          console.log(
            `Fast mode: Limiting to ${this.maxLinksPerSite} links per site`
          );
          break;
        }

        try {
          const linkUrl = new URL(link.url);
          // Only include http/https links
          if (linkUrl.protocol === 'http:' || linkUrl.protocol === 'https:') {
            // Skip certain link types in fast mode
            if (this.fastMode && this.shouldSkipInFastMode(link)) {
              continue;
            }

            links.add({
              url: link.url,
              text: link.text,
              sourceUrl: link.sourceUrl,
              type: link.type,
              element: link.element,
            });
            processedCount++;
          }
        } catch (error) {
          // Invalid URL, skip it
          continue;
        }
      }

      // If depth > 1, crawl internal links
      if (depth > 1 && !crawlBudget.exhausted) {
        const baseUrl = new URL(url);
        const internalLinks = Array.from(links).filter((link) => {
          try {
            const linkUrl = new URL(link.url);
            return linkUrl.hostname === baseUrl.hostname;
          } catch {
            return false;
          }
        });

        // Crawl a subset of internal links (limit to prevent infinite crawling)
        const linksToProcess = internalLinks.slice(0, 10);
        for (const link of linksToProcess) {
          throwIfAborted(signal);
          if (crawlBudget.exhausted) break;
          let alreadyVisited = false;
          try {
            const candidate = new URL(link.url);
            candidate.hash = '';
            alreadyVisited = crawlBudget.visitedPages.has(candidate.href);
          } catch {
            alreadyVisited = true;
          }
          if (alreadyVisited) continue;

          try {
            await abortableDelay(this.delay, signal);
            const subLinks = await this.extractLinks(
              link.url,
              depth - 1,
              crawlBudget,
              signal
            );
            subLinks.forEach((subLink) => links.add(subLink));
          } catch (error) {
            if (signal?.aborted) throw error;
            if (crawlBudget.exhausted) break;
            errors.push({
              url: link.url,
              error: error.message,
            });
          }
        }
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      if (!crawlBudget.exhausted) {
        errors.push({ url, error: error.message });
      }
    } finally {
      signal?.removeEventListener('abort', closePageOnAbort);
      await page.close().catch(() => {});
    }

    return {
      links: Array.from(links),
      errors,
    };
  }

  async checkLink(
    url,
    sourceUrl = null,
    retryCount = 0,
    linkType = 'anchor',
    budget = null,
    signal = null
  ) {
    throwIfAborted(signal);
    const startTime = Date.now();
    const result = {
      url,
      sourceUrl,
      linkType,
      status: 'unknown',
      statusCode: null,
      responseTime: 0,
      errorType: null,
      errorMessage: null,
      redirectChain: [],
      isExternalSocialMedia: this.isExternalSocialMedia(url),
      retryCount,
    };

    // Validate URL before attempting request
    if (!this.isValidUrl(url)) {
      result.status = 'broken';
      result.errorType = 'invalid_url';
      result.errorMessage = 'Invalid URL format';
      return result;
    }

    // Check cache first
    const cachedResult = this.getCachedResult(url);
    if (cachedResult) {
      console.log(`Cache hit for ${url}`);
      return { ...cachedResult, cached: true };
    }

    // Check circuit breaker
    const domain = this.extractDomain(url);
    if (domain && this.isCircuitOpen(domain)) {
      result.status = 'broken';
      result.errorType = 'circuit_breaker_open';
      result.errorMessage = 'Circuit breaker is open for this domain';
      return result;
    }

    try {
      // Use appropriate headers based on link type
      const headers = {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate, br',
        DNT: '1',
        Connection: 'keep-alive',
        'Cache-Control': 'max-age=0',
      };

      // Set appropriate Accept header based on link type
      if (linkType === 'image') {
        headers.Accept =
          'image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8';
      } else if (linkType === 'script') {
        headers.Accept = '*/*';
      } else if (linkType === 'link-element') {
        headers.Accept = 'text/css,*/*;q=0.1';
      } else {
        headers.Accept =
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8';
        headers['Upgrade-Insecure-Requests'] = '1';
        headers['Sec-Fetch-Dest'] = 'document';
        headers['Sec-Fetch-Mode'] = 'navigate';
        headers['Sec-Fetch-Site'] = 'none';
      }

      // Use HEAD request for images and scripts to be more efficient
      const method =
        linkType === 'image' || linkType === 'script' ? 'head' : 'get';

      const response = await requestPublicUrl(
        url,
        {
          method,
          timeout: this.timeout,
          maxRedirects: 5,
          headers,
          signal,
          beforeRequest: () => {
            throwIfAborted(signal);
            if (budget && !budget.reserveNetworkRequest()) {
              throw new CrawlBudgetExhaustedError(
                budget.terminationReason || 'max_network_requests_reached'
              );
            }
          },
        },
        {
          resolver: this.outboundResolver,
          validateAddress: this.outboundAddressValidator,
        }
      );

      result.statusCode = response.status;
      result.responseTime = Date.now() - startTime;

      // Enhanced status classification
      if (response.status >= 200 && response.status < 300) {
        result.status = 'success';
        result.errorType = null;
      } else if (response.status >= 300 && response.status < 400) {
        result.status = 'redirect';
        result.errorType = 'redirect';
        result.errorMessage = `Redirected to ${response.headers.location || 'unknown location'}`;
      } else if (response.status === 404) {
        result.status = 'broken';
        result.errorType = '404_not_found';
        result.errorMessage = 'Page not found';
      } else if (response.status === 403) {
        if (result.isExternalSocialMedia) {
          // Social media 403 is usually working but blocks bots
          result.status = 'success';
          result.errorType = 'social_media_block';
          result.errorMessage =
            'Social media link (blocks automated access but works in browser)';
        } else {
          result.status = 'broken';
          result.errorType = '403_forbidden';
          result.errorMessage = 'Access forbidden';
        }
      } else if (response.status === 401) {
        result.status = 'broken';
        result.errorType = '401_unauthorized';
        result.errorMessage = 'Authentication required';
      } else if (response.status === 400) {
        if (result.isExternalSocialMedia) {
          // Social media links that return 400 are usually working but block bots
          result.status = 'success';
          result.errorType = 'social_media_block';
          result.errorMessage =
            'Social media link (blocks automated access but works in browser)';
        } else {
          result.status = 'broken';
          result.errorType = '400_bad_request';
          result.errorMessage = 'Bad request';
        }
      } else if (response.status === 429) {
        result.status = 'broken';
        result.errorType = '429_rate_limited';
        result.errorMessage = 'Rate limited - too many requests';
      } else if (response.status >= 500 && response.status < 600) {
        result.status = 'broken';
        result.errorType = '500_server_error';
        result.errorMessage = `Server error (${response.status})`;
      } else if (response.status >= 400 && response.status < 500) {
        result.status = 'broken';
        result.errorType = '400_client_error';
        result.errorMessage = `Client error (${response.status})`;
      } else {
        result.status = 'broken';
        result.errorType = 'unknown_status';
        result.errorMessage = `Unknown status code: ${response.status}`;
      }
    } catch (error) {
      if (signal?.aborted) throwIfAborted(signal);
      if (
        error.code === 'CRAWL_BUDGET_EXHAUSTED' ||
        budget?.terminationReason === 'max_network_requests_reached'
      ) {
        result.status = 'skipped';
        result.errorType = 'crawl_budget_exhausted';
        result.errorMessage = budgetReasonMessage(
          budget?.terminationReason || error.terminationReason
        );
        return result;
      }

      result.responseTime = Date.now() - startTime;
      result.status = 'broken';
      result.errorMessage = error.message;

      // Enhanced error classification
      if (error.code === 'ECONNREFUSED') {
        result.errorType = 'connection_refused';
        result.errorMessage = 'Connection refused by server';
      } else if (error.code === 'ENOTFOUND') {
        result.errorType = 'dns_error';
        result.errorMessage = 'DNS resolution failed - domain not found';
      } else if (error.code === 'ECONNRESET') {
        result.errorType = 'connection_reset';
        result.errorMessage = 'Connection was reset by server';
      } else if (error.code === 'ETIMEDOUT') {
        result.errorType = 'timeout';
        result.errorMessage = 'Request timed out';
      } else if (error.code === 'ENETUNREACH') {
        result.errorType = 'network_unreachable';
        result.errorMessage = 'Network is unreachable';
      } else if (error.code === 'EHOSTUNREACH') {
        result.errorType = 'host_unreachable';
        result.errorMessage = 'Host is unreachable';
      } else if (error.code === 'ECONNABORTED') {
        result.errorType = 'connection_aborted';
        result.errorMessage = 'Connection was aborted';
      } else if (
        error.message.includes('SSL') ||
        error.message.includes('certificate') ||
        error.code === 'CERT_HAS_EXPIRED' ||
        error.code === 'CERT_UNTRUSTED'
      ) {
        result.errorType = 'ssl_error';
        result.errorMessage = 'SSL/TLS certificate error';
      } else if (error.code === 'EPROTO') {
        result.errorType = 'protocol_error';
        result.errorMessage = 'Protocol error';
      } else if (error.code === 'EAI_AGAIN') {
        result.errorType = 'dns_temporary_failure';
        result.errorMessage = 'DNS temporary failure - try again later';
      } else if (error.response) {
        // This shouldn't happen with validateStatus: () => true, but just in case
        result.statusCode = error.response.status;
        result.errorType = 'http_error';
        result.errorMessage = `HTTP error: ${error.response.status}`;
      } else {
        result.errorType = 'unknown_error';
        result.errorMessage = `Unknown error: ${error.message}`;
      }

      // Update circuit breaker on failure
      if (domain) {
        this.recordFailure(domain);
      }

      // Implement retry logic for transient errors
      if (this.shouldRetry(error, retryCount)) {
        const retryDelay = this.calculateRetryDelay(retryCount);
        console.log(
          `Retrying ${url} in ${retryDelay}ms (attempt ${retryCount + 1})`
        );

        await abortableDelay(retryDelay, signal);
        throwIfAborted(signal);
        return this.checkLink(
          url,
          sourceUrl,
          retryCount + 1,
          linkType,
          budget,
          signal
        );
      }
    }

    // Cache successful results
    if (result.status === 'success' && domain) {
      this.cacheResult(url, result);
      this.recordSuccess(domain);
    }

    return result;
  }

  // Enhanced URL validation
  isValidUrl(url) {
    try {
      const parsed = parseOutboundUrl(url);
      const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
      if (net.isIP(hostname)) return isPublicAddress(hostname);
      return true;
    } catch {
      return false;
    }
  }

  // Check if hostname is private or localhost
  isPrivateOrLocalhost(hostname) {
    return !isPublicAddress(hostname);
  }

  // Determine if a request should be retried
  shouldRetry(error, retryCount) {
    if (retryCount >= this.maxRetries) {
      return false;
    }

    // Retry on transient errors
    const retryableErrors = [
      'ECONNRESET',
      'ETIMEDOUT',
      'ECONNREFUSED',
      'ENOTFOUND',
      'ENETUNREACH',
      'EHOSTUNREACH',
      'EAI_AGAIN',
      'dns_temporary_failure',
    ];

    // Retry on 5xx server errors
    if (error.response && error.response.status >= 500) {
      return true;
    }

    // Retry on rate limiting (429)
    if (error.response && error.response.status === 429) {
      return true;
    }

    // Retry on network errors
    if (
      retryableErrors.includes(error.code) ||
      retryableErrors.includes(error.errorType)
    ) {
      return true;
    }

    return false;
  }

  // Calculate exponential backoff delay
  calculateRetryDelay(retryCount) {
    const baseDelay = this.retryDelay;
    const maxDelay = 10000; // 10 seconds
    const delay = Math.min(baseDelay * Math.pow(2, retryCount), maxDelay);

    // Add jitter to prevent thundering herd
    const jitter = Math.random() * 0.1 * delay;
    return Math.floor(delay + jitter);
  }

  // Helper method to detect social media and external platforms
  isExternalSocialMedia(url) {
    const socialMediaDomains = [
      'twitter.com',
      'x.com',
      'facebook.com',
      'instagram.com',
      'linkedin.com',
      'youtube.com',
      'tiktok.com',
      'whatsapp.com',
      'telegram.org',
      'pinterest.com',
      'snapchat.com',
    ];

    try {
      const urlObj = new URL(url);
      return socialMediaDomains.some(
        (domain) =>
          urlObj.hostname === domain || urlObj.hostname.endsWith('.' + domain)
      );
    } catch {
      return false;
    }
  }

  async checkMultipleLinks(
    links,
    onProgress = null,
    budget = null,
    signal = null
  ) {
    const results = [];
    const total = links.length;
    const maxConcurrent = config.crawler.maxConcurrent || 5;
    const rateLimiter = new Map(); // Track requests per domain

    // Process links in batches to control concurrency
    for (let i = 0; i < links.length; i += maxConcurrent) {
      throwIfAborted(signal);
      if (budget?.networkRequestLimitReached) {
        if (i < links.length) budget.reserveNetworkRequest();
        break;
      }
      const batch = links.slice(i, i + maxConcurrent);

      // Process batch concurrently
      const batchPromises = batch.map(async (link, batchIndex) => {
        const globalIndex = i + batchIndex;

        try {
          throwIfAborted(signal);
          // Enhanced rate limiting per domain
          const domain = this.extractDomain(link.url);
          if (domain) {
            await this.enforceRateLimit(domain, signal);
          }
          throwIfAborted(signal);

          const result = await this.checkLink(
            link.url,
            link.sourceUrl,
            0,
            link.type,
            budget,
            signal
          );
          result.linkText = link.text;

          if (onProgress) {
            onProgress({
              current: globalIndex + 1,
              total,
              percentage: Math.round(((globalIndex + 1) / total) * 100),
              currentUrl: link.url,
              result,
            });
          }

          return result;
        } catch (error) {
          if (signal?.aborted) throw error;
          const errorResult = {
            url: link.url,
            sourceUrl: link.sourceUrl,
            linkText: link.text,
            status: 'error',
            errorMessage: error.message,
            errorType: 'other',
          };

          if (onProgress) {
            onProgress({
              current: globalIndex + 1,
              total,
              percentage: Math.round(((globalIndex + 1) / total) * 100),
              currentUrl: link.url,
              result: errorResult,
            });
          }

          return errorResult;
        }
      });

      // Wait for batch to complete
      const batchResults = await Promise.all(batchPromises);
      throwIfAborted(signal);
      results.push(...batchResults);

      // Add delay between batches to be respectful to servers
      if (i + maxConcurrent < links.length) {
        await new Promise((resolve) => setTimeout(resolve, this.delay));
      }
    }

    return results;
  }

  // Extract domain from URL for rate limiting
  extractDomain(url) {
    try {
      const urlObj = new URL(url);
      return urlObj.hostname;
    } catch {
      return null;
    }
  }

  // Enhanced rate limiting per domain with fast mode optimization
  async enforceRateLimit(domain, signal = null) {
    throwIfAborted(signal);
    // Skip rate limiting in fast mode for better performance
    if (this.fastMode) {
      return;
    }

    const now = Date.now();
    const rateLimiter = this.domainRateLimiters.get(domain);

    if (!rateLimiter) {
      this.domainRateLimiters.set(domain, {
        requests: [now],
        lastCleanup: now,
      });
      return;
    }

    // Clean up old requests (older than 1 second)
    const oneSecondAgo = now - 1000;
    rateLimiter.requests = rateLimiter.requests.filter(
      (time) => time > oneSecondAgo
    );

    // Check if we're within rate limit
    if (rateLimiter.requests.length >= this.rateLimitPerDomain) {
      const oldestRequest = Math.min(...rateLimiter.requests);
      const waitTime = 1000 - (now - oldestRequest);

      if (waitTime > 0) {
        console.log(`Rate limiting ${domain}: waiting ${waitTime}ms`);
        await abortableDelay(waitTime, signal);
      }
    }

    // Add current request
    rateLimiter.requests.push(now);
    rateLimiter.lastCleanup = now;

    // Periodic cleanup of rate limiter map
    if (now - rateLimiter.lastCleanup > 60000) {
      // 1 minute
      this.cleanupRateLimiters();
    }
  }

  // Determine if link should be skipped in fast mode
  shouldSkipInFastMode(link) {
    // Skip certain link types in fast mode for speed
    const skipTypes = ['script', 'link-element', 'background-image'];
    if (skipTypes.includes(link.type)) {
      return true;
    }

    // Skip image links with very long URLs (likely dynamic)
    if (link.type === 'image' && link.url.length > 200) {
      return true;
    }

    // Skip anchor links to same page
    if (link.type === 'anchor' && link.url.includes('#')) {
      return true;
    }

    return false;
  }

  // Clean up old rate limiters
  cleanupRateLimiters() {
    const now = Date.now();
    for (const [domain, limiter] of this.domainRateLimiters.entries()) {
      if (now - limiter.lastCleanup > 300000) {
        // 5 minutes
        this.domainRateLimiters.delete(domain);
      }
    }
  }

  // Circuit Breaker Methods
  isCircuitOpen(domain) {
    const breaker = this.circuitBreakers.get(domain);
    if (!breaker) return false;

    if (breaker.state === 'OPEN') {
      // Check if we should try to close the circuit
      if (Date.now() - breaker.lastFailureTime > breaker.timeout) {
        breaker.state = 'HALF_OPEN';
        console.log(`Circuit breaker for ${domain} moved to HALF_OPEN`);
        return false;
      }
      return true;
    }

    return false;
  }

  recordFailure(domain) {
    let breaker = this.circuitBreakers.get(domain);
    if (!breaker) {
      breaker = {
        state: 'CLOSED',
        failureCount: 0,
        successCount: 0,
        lastFailureTime: 0,
        timeout: this.circuitBreakerTimeout,
        failureThreshold: this.circuitBreakerThreshold,
      };
      this.circuitBreakers.set(domain, breaker);
    }

    breaker.failureCount++;
    breaker.lastFailureTime = Date.now();

    if (breaker.failureCount >= breaker.failureThreshold) {
      breaker.state = 'OPEN';
      console.log(
        `Circuit breaker for ${domain} opened after ${breaker.failureCount} failures`
      );
    }
  }

  recordSuccess(domain) {
    const breaker = this.circuitBreakers.get(domain);
    if (!breaker) return;

    breaker.successCount++;

    if (breaker.state === 'HALF_OPEN' && breaker.successCount >= 3) {
      breaker.state = 'CLOSED';
      breaker.failureCount = 0;
      breaker.successCount = 0;
      console.log(
        `Circuit breaker for ${domain} closed after successful requests`
      );
    }
  }

  // Caching Methods
  getCachedResult(url) {
    const cached = this.requestCache.get(url);
    if (!cached) return null;

    // Check if cache is still valid
    if (Date.now() - cached.timestamp > this.cacheTimeout) {
      this.requestCache.delete(url);
      return null;
    }

    return cached.result;
  }

  cacheResult(url, result) {
    this.requestCache.set(url, {
      result: { ...result },
      timestamp: Date.now(),
    });

    // Clean up old cache entries periodically
    if (this.requestCache.size > 1000) {
      this.cleanupCache();
    }
  }

  cleanupCache() {
    const now = Date.now();
    for (const [url, cached] of this.requestCache.entries()) {
      if (now - cached.timestamp > this.cacheTimeout) {
        this.requestCache.delete(url);
      }
    }
  }

  async crawlWebsite(url, options = {}) {
    const { depth = 1, onProgress = null, signal = null } = options;
    throwIfAborted(signal);
    const budget = new CrawlBudget({
      maxPages: config.crawler.maxPagesPerCrawl,
      maxNetworkRequests: config.crawler.maxNetworkRequestsPerCrawl,
    });
    const crawlId = `crawl-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    console.log(`[${crawlId}] Starting crawl for: ${url}`);

    const crawlResult = {
      url,
      crawlId,
      startTime: new Date(),
      endTime: null,
      totalLinksFound: 0,
      totalLinksChecked: 0,
      brokenLinksFound: 0,
      redirectsFound: 0,
      timeoutsFound: 0,
      averageResponseTime: 0,
      links: [],
      brokenLinks: [],
      errors: [],
      metrics: {
        cacheHits: 0,
        retries: 0,
        circuitBreakerTrips: 0,
        domainsChecked: new Set(),
      },
      budget: budget.toJSON(),
      terminationReason: null,
    };

    try {
      // Extract links from the website
      const { links, errors } = await this.extractLinks(
        url,
        depth,
        budget,
        signal
      );
      throwIfAborted(signal);
      crawlResult.links = links;
      crawlResult.errors = errors;
      crawlResult.totalLinksFound = links.length;

      if (onProgress) {
        onProgress({
          phase: 'extraction',
          message: `Found ${links.length} links to check`,
          budget: budget.toJSON(),
        });
      }

      // Check each link
      const linkResults = await this.checkMultipleLinks(
        links,
        (progress) => {
          // Track metrics
          if (progress.result) {
            if (progress.result.cached) {
              crawlResult.metrics.cacheHits++;
            }
            if (progress.result.retryCount > 0) {
              crawlResult.metrics.retries += progress.result.retryCount;
            }
            if (progress.result.errorType === 'circuit_breaker_open') {
              crawlResult.metrics.circuitBreakerTrips++;
            }

            const domain = this.extractDomain(progress.result.url);
            if (domain) {
              crawlResult.metrics.domainsChecked.add(domain);
            }
          }

          if (onProgress) {
            onProgress({
              phase: 'checking',
              ...progress,
              metrics: crawlResult.metrics,
              budget: budget.toJSON(),
            });
          }
        },
        budget,
        signal
      );
      throwIfAborted(signal);

      // Process results
      crawlResult.totalLinksChecked = linkResults.filter(
        (result) => result.status !== 'skipped'
      ).length;
      let totalResponseTime = 0;

      for (const result of linkResults) {
        if (result.responseTime) {
          totalResponseTime += result.responseTime;
        }

        if (result.status === 'broken') {
          crawlResult.brokenLinksFound++;
          crawlResult.brokenLinks.push(result);
        } else if (result.status === 'redirect') {
          crawlResult.redirectsFound++;
        }

        if (result.errorType === 'timeout') {
          crawlResult.timeoutsFound++;
        }
      }

      crawlResult.averageResponseTime =
        crawlResult.totalLinksChecked > 0
          ? Math.round(totalResponseTime / crawlResult.totalLinksChecked)
          : 0;

      // Convert Set to Array for JSON serialization
      crawlResult.metrics.domainsChecked = Array.from(
        crawlResult.metrics.domainsChecked
      );

      crawlResult.endTime = new Date();
      crawlResult.budget = budget.toJSON();
      crawlResult.terminationReason = budget.terminationReason;
      if (budget.terminationReason) {
        crawlResult.errors.push({
          url,
          error: budgetReasonMessage(budget.terminationReason),
          errorType: budget.terminationReason,
        });
      }

      // Log crawl completion with metrics
      const duration = crawlResult.endTime - crawlResult.startTime;
      console.log(
        `[${crawlId}] ${budget.terminationReason ? 'Crawl stopped early' : 'Crawl completed'} in ${duration}ms:`,
        {
          totalLinks: crawlResult.totalLinksFound,
          pagesProcessed: budget.pagesProcessed,
          networkRequests: budget.networkRequests,
          brokenLinks: crawlResult.brokenLinksFound,
          cacheHits: crawlResult.metrics.cacheHits,
          retries: crawlResult.metrics.retries,
          circuitBreakerTrips: crawlResult.metrics.circuitBreakerTrips,
          uniqueDomains: crawlResult.metrics.domainsChecked.length,
          averageResponseTime: crawlResult.averageResponseTime,
        }
      );

      return crawlResult;
    } catch (error) {
      if (signal?.aborted) throwIfAborted(signal);
      crawlResult.endTime = new Date();
      crawlResult.errors.push({
        url,
        error: error.message,
      });
      throw error;
    }
  }
}

module.exports = WebCrawler;
