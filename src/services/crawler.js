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

  async checkLink(url, sourceUrl = null) {
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
    };

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

      if (response.status >= 200 && response.status < 300) {
        result.status = 'success';
      } else if (response.status >= 300 && response.status < 400) {
        result.status = 'redirect';
        result.errorType = 'redirect';
      } else if (response.status === 404) {
        result.status = 'broken';
        result.errorType = '404_not_found';
      } else if (response.status === 403 && result.isExternalSocialMedia) {
        // Social media 403 is also usually working but blocks bots
        result.status = 'success';
        result.errorType = null;
        result.errorMessage =
          'Social media link (blocks automated access but works in browser)';
      } else if (response.status === 403) {
        result.status = 'broken';
        result.errorType = '403_forbidden';
      } else if (response.status === 400 && result.isExternalSocialMedia) {
        // Social media links that return 400 are usually working but block bots
        // Count them as working links, not broken
        result.status = 'success';
        result.errorType = null;
        result.errorMessage =
          'Social media link (blocks automated access but works in browser)';
      } else if (response.status >= 500) {
        result.status = 'broken';
        result.errorType = '500_server_error';
      } else {
        result.status = 'broken';
        result.errorType = 'other';
      }
    } catch (error) {
      result.responseTime = Date.now() - startTime;
      result.status = 'broken';
      result.errorMessage = error.message;

      if (error.code === 'ECONNREFUSED') {
        result.errorType = 'connection_refused';
      } else if (error.code === 'ENOTFOUND') {
        result.errorType = 'dns_error';
      } else if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT') {
        result.errorType = 'timeout';
      } else if (
        error.message.includes('SSL') ||
        error.message.includes('certificate')
      ) {
        result.errorType = 'ssl_error';
      } else {
        result.errorType = 'other';
      }
    }

    return result;
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

    for (let i = 0; i < links.length; i++) {
      const link = links[i];

      try {
        const result = await this.checkLink(link.url, link.sourceUrl);
        result.linkText = link.text;
        results.push(result);

        if (onProgress) {
          onProgress({
            current: i + 1,
            total,
            percentage: Math.round(((i + 1) / total) * 100),
            currentUrl: link.url,
            result,
          });
        }

        // Add delay between requests to be respectful
        if (this.delay && i < links.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, this.delay));
        }
      } catch (error) {
        results.push({
          url: link.url,
          sourceUrl: link.sourceUrl,
          linkText: link.text,
          status: 'error',
          errorMessage: error.message,
          errorType: 'other',
        });
      }
    }

    return results;
  }

  async crawlWebsite(url, options = {}) {
    const { depth = 1, onProgress = null } = options;

    const crawlResult = {
      url,
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
        if (onProgress) {
          onProgress({
            phase: 'checking',
            ...progress,
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

      crawlResult.endTime = new Date();

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
