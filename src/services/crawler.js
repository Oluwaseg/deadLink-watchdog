const puppeteer = require('puppeteer');
const axios = require('axios');
const { URL } = require('url');
const config = require('../../config/config');

class WebCrawler {
  constructor() {
    this.browser = null;
    this.userAgent = config.crawler.userAgent;
    this.timeout = config.crawler.timeout;
    this.delay = config.crawler.delay;
    this.maxRetries = config.crawler.maxRetries;
    this.retryDelay = config.crawler.retryDelay;
    this.circuitBreakerTimeout = config.crawler.circuitBreakerTimeout;
    this.circuitBreakerThreshold = config.crawler.circuitBreakerThreshold;
    this.cacheTimeout = config.crawler.cacheTimeout;
    this.rateLimitPerDomain = config.crawler.rateLimitPerDomain;
    this.circuitBreakers = new Map(); // Track circuit breaker state per domain
    this.requestCache = new Map(); // Simple in-memory cache for recent requests
    this.domainRateLimiters = new Map(); // Track rate limiting per domain
  }

  async initialize() {
    if (!this.browser) {
      this.browser = await puppeteer.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--disable-gpu',
        ],
      });
    }
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  async extractLinks(url, depth = 1) {
    await this.initialize();

    const page = await this.browser.newPage();
    await page.setUserAgent(this.userAgent);

    // Set a shorter timeout for page operations
    page.setDefaultTimeout(this.timeout);

    const links = new Set();
    const errors = [];

    try {
      console.log(`Extracting links from: ${url}`);

      // Navigate to the page with a more lenient wait condition
      await page.goto(url, {
        waitUntil: 'domcontentloaded', // Changed from 'networkidle2' to be faster
        timeout: this.timeout,
      });

      console.log(`Successfully loaded page: ${url}`);

      // Extract all links from the page
      const pageLinks = await page.evaluate(() => {
        const anchors = Array.from(document.querySelectorAll('a[href]'));
        return anchors.map((anchor) => ({
          url: anchor.href,
          text: anchor.textContent.trim(),
          sourceUrl: window.location.href,
        }));
      });

      console.log(`Found ${pageLinks.length} links on page: ${url}`);

      // Process each link
      for (const link of pageLinks) {
        try {
          const linkUrl = new URL(link.url);
          // Only include http/https links
          if (linkUrl.protocol === 'http:' || linkUrl.protocol === 'https:') {
            links.add({
              url: link.url,
              text: link.text,
              sourceUrl: link.sourceUrl,
            });
          }
        } catch (error) {
          // Invalid URL, skip it
          continue;
        }
      }

      // If depth > 1, crawl internal links
      if (depth > 1) {
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
          try {
            (await this.delay) &&
              new Promise((resolve) => setTimeout(resolve, this.delay));
            const subLinks = await this.extractLinks(link.url, depth - 1);
            subLinks.forEach((subLink) => links.add(subLink));
          } catch (error) {
            errors.push({
              url: link.url,
              error: error.message,
            });
          }
        }
      }
    } catch (error) {
      errors.push({
        url: url,
        error: error.message,
      });
    } finally {
      await page.close();
    }

    return {
      links: Array.from(links),
      errors,
    };
  }

  async checkLink(url, sourceUrl = null, retryCount = 0) {
    const startTime = Date.now();
    const result = {
      url,
      sourceUrl,
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
      // Use more realistic browser headers for better compatibility
      const response = await axios.get(url, {
        timeout: this.timeout,
        maxRedirects: 5,
        validateStatus: () => true, // Don't throw on 4xx/5xx
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept:
            'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
          'Accept-Encoding': 'gzip, deflate, br',
          DNT: '1',
          Connection: 'keep-alive',
          'Upgrade-Insecure-Requests': '1',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none',
          'Cache-Control': 'max-age=0',
        },
      });

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
          result.errorMessage = 'Social media link (blocks automated access but works in browser)';
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
          result.errorMessage = 'Social media link (blocks automated access but works in browser)';
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
        console.log(`Retrying ${url} in ${retryDelay}ms (attempt ${retryCount + 1})`);
        
        await new Promise(resolve => setTimeout(resolve, retryDelay));
        return this.checkLink(url, sourceUrl, retryCount + 1);
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
      const urlObj = new URL(url);
      
      // Check protocol
      if (!['http:', 'https:'].includes(urlObj.protocol)) {
        return false;
      }
      
      // Check for suspicious patterns
      const suspiciousPatterns = [
        /javascript:/i,
        /data:/i,
        /file:/i,
        /ftp:/i,
        /mailto:/i,
        /tel:/i,
        /sms:/i,
        /whatsapp:/i,
        /telegram:/i,
      ];
      
      if (suspiciousPatterns.some(pattern => pattern.test(url))) {
        return false;
      }
      
      // Check for valid hostname
      if (!urlObj.hostname || urlObj.hostname.length === 0) {
        return false;
      }
      
      // Check for localhost/private IPs (unless in development)
      if (this.isPrivateOrLocalhost(urlObj.hostname)) {
        return false;
      }
      
      return true;
    } catch {
      return false;
    }
  }

  // Check if hostname is private or localhost
  isPrivateOrLocalhost(hostname) {
    const privatePatterns = [
      /^localhost$/i,
      /^127\./,
      /^192\.168\./,
      /^10\./,
      /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
      /^0\.0\.0\.0$/,
    ];
    
    return privatePatterns.some(pattern => pattern.test(hostname));
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
    if (retryableErrors.includes(error.code) || retryableErrors.includes(error.errorType)) {
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

  async checkMultipleLinks(links, onProgress = null) {
    const results = [];
    const total = links.length;
    const maxConcurrent = config.crawler.maxConcurrent || 5;
    const rateLimiter = new Map(); // Track requests per domain

    // Process links in batches to control concurrency
    for (let i = 0; i < links.length; i += maxConcurrent) {
      const batch = links.slice(i, i + maxConcurrent);
      
      // Process batch concurrently
      const batchPromises = batch.map(async (link, batchIndex) => {
        const globalIndex = i + batchIndex;
        
        try {
          // Enhanced rate limiting per domain
          const domain = this.extractDomain(link.url);
          if (domain) {
            await this.enforceRateLimit(domain);
          }

          const result = await this.checkLink(link.url, link.sourceUrl);
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
      results.push(...batchResults);
      
      // Add delay between batches to be respectful to servers
      if (i + maxConcurrent < links.length) {
        await new Promise(resolve => setTimeout(resolve, this.delay));
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

  // Enhanced rate limiting per domain
  async enforceRateLimit(domain) {
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
    rateLimiter.requests = rateLimiter.requests.filter(time => time > oneSecondAgo);
    
    // Check if we're within rate limit
    if (rateLimiter.requests.length >= this.rateLimitPerDomain) {
      const oldestRequest = Math.min(...rateLimiter.requests);
      const waitTime = 1000 - (now - oldestRequest);
      
      if (waitTime > 0) {
        console.log(`Rate limiting ${domain}: waiting ${waitTime}ms`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }
    
    // Add current request
    rateLimiter.requests.push(now);
    rateLimiter.lastCleanup = now;
    
    // Periodic cleanup of rate limiter map
    if (now - rateLimiter.lastCleanup > 60000) { // 1 minute
      this.cleanupRateLimiters();
    }
  }

  // Clean up old rate limiters
  cleanupRateLimiters() {
    const now = Date.now();
    for (const [domain, limiter] of this.domainRateLimiters.entries()) {
      if (now - limiter.lastCleanup > 300000) { // 5 minutes
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
      console.log(`Circuit breaker for ${domain} opened after ${breaker.failureCount} failures`);
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
      console.log(`Circuit breaker for ${domain} closed after successful requests`);
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
    const { depth = 1, onProgress = null } = options;
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
    };

    try {
      // Extract links from the website
      const { links, errors } = await this.extractLinks(url, depth);
      crawlResult.links = links;
      crawlResult.errors = errors;
      crawlResult.totalLinksFound = links.length;

      if (onProgress) {
        onProgress({
          phase: 'extraction',
          message: `Found ${links.length} links to check`,
        });
      }

      // Check each link
      const linkResults = await this.checkMultipleLinks(links, (progress) => {
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
          });
        }
      });

      // Process results
      crawlResult.totalLinksChecked = linkResults.length;
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
      crawlResult.metrics.domainsChecked = Array.from(crawlResult.metrics.domainsChecked);
      
      crawlResult.endTime = new Date();
      
      // Log crawl completion with metrics
      const duration = crawlResult.endTime - crawlResult.startTime;
      console.log(`[${crawlId}] Crawl completed in ${duration}ms:`, {
        totalLinks: crawlResult.totalLinksFound,
        brokenLinks: crawlResult.brokenLinksFound,
        cacheHits: crawlResult.metrics.cacheHits,
        retries: crawlResult.metrics.retries,
        circuitBreakerTrips: crawlResult.metrics.circuitBreakerTrips,
        uniqueDomains: crawlResult.metrics.domainsChecked.length,
        averageResponseTime: crawlResult.averageResponseTime,
      });

      return crawlResult;
    } catch (error) {
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
