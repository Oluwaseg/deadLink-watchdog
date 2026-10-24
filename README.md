# DeadLink Watchdog Backend

DeadLink Watchdog helps people and organizations keep the links on websites they manage healthy. The backend manages user accounts, stores monitored websites, runs link crawls, records crawl results and broken-link details, and provides user and administrator reporting.

The service is designed around recurring monitoring: a website can be crawled when it is first added, on demand, and automatically when its configured crawl frequency is due. Results are retained so users can review current issues and crawl history rather than relying on a one-time check.

## What the backend does

### Account and access management

The backend supports account registration, email verification, login, token refresh, profile updates, password changes, and password recovery. Passwords are stored as hashes. User-facing website, crawl, and dashboard data is scoped to the authenticated account. Administrative operations require an authenticated account with the administrator role.

New accounts must verify their email before logging in. Accounts can be active or deactivated, and deactivated accounts are rejected during authentication.

### Website monitoring

Each user can manage their own monitored websites. A website record can include its URL, name, description, category, active state, crawl frequency, notification email, webhook destination, most recent crawl time, link totals, broken-link count, health score, and moderation state.

Adding a website queues its first crawl. Users can update or remove their websites, enable or disable a website, request a manual crawl, and review its crawl history and discovered broken links. The same URL can be monitored by different accounts, but duplicate URLs are prevented within one account.

### Link discovery and checking

The crawler loads the website in a headless browser and discovers URLs from page elements such as links, images, forms, stylesheets, scripts, and CSS background images. It filters discoveries to HTTP and HTTPS URLs, then checks links in batches with bounded concurrency. It uses request methods appropriate to the resource type and records response status, response time, and classified network or HTTP errors.

A depth-one crawl checks links discovered on the starting page. Deeper crawls can follow a limited number of links on the same host, up to the supported crawl-depth limit. This is a bounded crawler, not a complete site-map or unrestricted web crawler. Fast mode can reduce crawl coverage by limiting the number and types of resources inspected.

### Crawl history and broken-link records

Each crawl is tracked with a status, start and completion times, crawl depth, link totals, broken-link totals, redirect and timeout counts, average response time, and an error summary when applicable. Failed attempts are retained as failed crawl records with an error message.

A discovered broken link is stored with its URL, source page, link text when available, HTTP status when available, error classification, response time, and redirect-chain data. Records are associated with both the monitored website and the crawl that found them, allowing users to inspect issues in the context of a particular run.

### Website health and user dashboards

After a successful crawl, the backend updates the website's most recent crawl time, number of checked links, number of broken links, next scheduled crawl time, and health score. The score is calculated from the checked links and broken links:

`health score = max(0, 100 - broken links / checked links × 100)`

The user dashboard summarizes website totals and active websites, crawl activity, broken links, recent activity, website health, crawl performance, website categories, and generated alerts. Dashboard queries are restricted to the signed-in user's websites and crawl records. The overview's average health figure is based on up to the five lowest-scoring websites, surfaced as the top issues, rather than every website in the account.

### Scheduled and background work

Crawls run as background jobs so requests to add a website or request a crawl do not need to wait for the full crawl to complete. Jobs are retried after failures using backoff. A crawl worker creates and updates the crawl record, saves discovered issues, refreshes website statistics, and reports progress while the job runs.

A scheduler checks for active websites whose configured crawl frequency is due, queues their crawls, and advances their next-crawl time. Supported frequencies are daily, weekly, and monthly; scheduled times are set for 2:00 AM. The scheduler also cleans old queue jobs and periodically checks queue and stale-website health.

### Notifications

A website can have an email address and a webhook destination for crawl notifications. Email notifications are sent when a crawl finds broken links and for scheduled crawls. Webhook notifications are sent after a completed crawl when a webhook destination is configured; the payload includes website and crawl summaries and up to ten broken-link details.

Notification delivery is best-effort. An email or webhook failure is logged but does not turn an otherwise successful crawl into a failed crawl.

### Administrator operations

Administrators can review system-wide totals for users, websites, crawls, broken links, active websites, and queue activity. Administrative tools also support user search and filtering, changing a user's role or active status, reviewing flagged or reported websites, blocking or unblocking websites, and viewing user and website analytics.

The administrator role is checked from the authenticated user's current database record. User listings omit password hashes.

## Main data concepts

- **User:** account identity, verification and activity state, and access role.
- **Website:** an account-owned monitoring target, crawl preferences, notification destinations, moderation state, and latest health summary.
- **Crawl result:** the outcome and measurements for one crawl attempt.
- **Broken link:** a link issue found during a crawl, including its source and diagnostic details.

These records connect a user's monitoring configuration to the crawl history and evidence used by the dashboards and administrator tools.

## Current scope

The crawler currently performs bounded, browser-rendered discovery and link checking. It does not implement sitemap ingestion, robots.txt handling, authenticated crawling of protected sites, or custom request-header configuration; these are tracked as future work in the v2 roadmap. Crawl depth and the number of same-host pages followed are intentionally limited.

Website report and moderation fields are available to administrators, but the current user-facing website flows do not provide a reporting workflow. Broken-link records include fixed-state fields, though the current routes do not expose an action to mark a broken link as fixed.

## Version 2.0 roadmap

Planned product and platform improvements are tracked separately. See the [DeadLink Watchdog v2.0 roadmap](ROADMAP.md) for proposed subscription plans, enhanced crawling, analytics, team collaboration, integrations, security improvements, and infrastructure work.
