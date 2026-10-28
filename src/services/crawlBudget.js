const { URL } = require('url');

class CrawlBudget {
  constructor({ maxPages, maxNetworkRequests }) {
    this.maxPages = maxPages;
    this.maxNetworkRequests = maxNetworkRequests;
    this.pagesProcessed = 0;
    this.networkRequests = 0;
    this.terminationReason = null;
    this.visitedPages = new Set();
  }

  reservePage(url) {
    let pageUrl;
    try {
      const normalized = new URL(url);
      normalized.hash = '';
      pageUrl = normalized.href;
    } catch {
      pageUrl = url;
    }

    if (this.visitedPages.has(pageUrl)) {
      return { allowed: false, duplicate: true };
    }

    if (this.pagesProcessed >= this.maxPages) {
      this.terminationReason ||= 'max_pages_reached';
      return { allowed: false, duplicate: false };
    }

    this.visitedPages.add(pageUrl);
    this.pagesProcessed += 1;
    return { allowed: true, duplicate: false };
  }

  reserveNetworkRequest() {
    if (this.networkRequests >= this.maxNetworkRequests) {
      this.terminationReason ||= 'max_network_requests_reached';
      return false;
    }

    this.networkRequests += 1;
    return true;
  }

  get exhausted() {
    return this.terminationReason !== null;
  }

  get networkRequestLimitReached() {
    return this.networkRequests >= this.maxNetworkRequests;
  }

  toJSON() {
    return {
      maxPages: this.maxPages,
      maxNetworkRequests: this.maxNetworkRequests,
      pagesProcessed: this.pagesProcessed,
      networkRequests: this.networkRequests,
      terminationReason: this.terminationReason,
    };
  }
}

module.exports = CrawlBudget;