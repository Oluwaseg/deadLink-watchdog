const nodemailer = require('nodemailer');
const config = require('../../config/config');
const { requestPublicUrl } = require('./outboundUrlPolicy');

class NotificationService {
  constructor() {
    this.emailTransporter = null;
    this.initializeEmailTransporter();
  }

  initializeEmailTransporter() {
    if (config.email.user && config.email.password) {
      this.emailTransporter = nodemailer.createTransporter({
        host: config.email.host,
        port: config.email.port,
        secure: config.email.port === 465,
        auth: {
          user: config.email.user,
          pass: config.email.password,
        },
      });
    }
  }

  async sendEmail(to, subject, htmlContent, textContent = null) {
    if (!this.emailTransporter) {
      throw new Error('Email transporter not configured');
    }

    const mailOptions = {
      from: config.email.from,
      to,
      subject,
      html: htmlContent,
      text: textContent || this.stripHtml(htmlContent),
    };

    try {
      const result = await this.emailTransporter.sendMail(mailOptions);
      return {
        success: true,
        messageId: result.messageId,
      };
    } catch (error) {
      console.error('Email sending failed:', error);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  async sendWebhook(url, data) {
    try {
      const response = await requestPublicUrl(url, {
        method: 'post',
        data,
        timeout: config.notifications.webhookTimeout,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'DeadLinkWatchdog/1.0',
        },
      });

      return {
        success: true,
        statusCode: response.status,
        response: response.data,
      };
    } catch (error) {
      console.error('Webhook sending failed:', error);
      return {
        success: false,
        error: error.message,
        statusCode: error.response?.status,
      };
    }
  }

  generateCrawlReportEmail(website, crawlResult) {
    const brokenLinksCount = crawlResult.brokenLinksFound;
    const totalLinksCount = crawlResult.totalLinksChecked;
    const healthScore =
      totalLinksCount > 0
        ? Math.round(
            ((totalLinksCount - brokenLinksCount) / totalLinksCount) * 100
          )
        : 100;

    const subject =
      brokenLinksCount > 0
        ? `🚨 ${brokenLinksCount} Broken Links Found on ${website.name}`
        : `✅ No Broken Links Found on ${website.name}`;

    const htmlContent = `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .header { background-color: #f8f9fa; padding: 20px; border-radius: 5px; margin-bottom: 20px; }
          .summary { background-color: #e9ecef; padding: 15px; border-radius: 5px; margin-bottom: 20px; }
          .broken-link { background-color: #f8d7da; padding: 10px; margin: 10px 0; border-radius: 3px; }
          .success { color: #28a745; }
          .warning { color: #ffc107; }
          .danger { color: #dc3545; }
          .footer { margin-top: 30px; padding-top: 20px; border-top: 1px solid #dee2e6; font-size: 12px; color: #6c757d; }
        </style>
      </head>
      <body>
        <div class="header">
          <h2>DeadLink Watchdog Report</h2>
          <p><strong>Website:</strong> ${website.name} (${website.url})</p>
          <p><strong>Scan Date:</strong> ${new Date(crawlResult.startTime).toLocaleString()}</p>
        </div>

        <div class="summary">
          <h3>Summary</h3>
          <ul>
            <li><strong>Total Links Checked:</strong> ${totalLinksCount}</li>
            <li><strong>Broken Links Found:</strong> <span class="${brokenLinksCount > 0 ? 'danger' : 'success'}">${brokenLinksCount}</span></li>
            <li><strong>Redirects Found:</strong> ${crawlResult.redirectsFound}</li>
            <li><strong>Timeouts:</strong> ${crawlResult.timeoutsFound}</li>
            <li><strong>Health Score:</strong> <span class="${healthScore >= 90 ? 'success' : healthScore >= 70 ? 'warning' : 'danger'}">${healthScore}%</span></li>
            <li><strong>Average Response Time:</strong> ${crawlResult.averageResponseTime}ms</li>
          </ul>
        </div>

        ${
          brokenLinksCount > 0
            ? `
          <h3>Broken Links Details</h3>
          ${crawlResult.brokenLinks
            .slice(0, 20)
            .map(
              (link) => `
            <div class="broken-link">
              <p><strong>URL:</strong> <a href="${link.url}">${link.url}</a></p>
              <p><strong>Source:</strong> <a href="${link.sourceUrl}">${link.sourceUrl}</a></p>
              <p><strong>Error:</strong> ${link.errorType} ${link.statusCode ? `(${link.statusCode})` : ''}</p>
              ${link.linkText ? `<p><strong>Link Text:</strong> "${link.linkText}"</p>` : ''}
              ${link.errorMessage ? `<p><strong>Error Message:</strong> ${link.errorMessage}</p>` : ''}
            </div>
          `
            )
            .join('')}
          ${brokenLinksCount > 20 ? `<p><em>... and ${brokenLinksCount - 20} more broken links</em></p>` : ''}
        `
            : ''
        }

        <div class="footer">
          <p>This report was generated by DeadLink Watchdog. Visit your dashboard for more details and to manage your websites.</p>
          <p>If you no longer wish to receive these notifications, please update your notification settings in your account.</p>
        </div>
      </body>
      </html>
    `;

    return { subject, htmlContent };
  }

  generateWebhookPayload(website, crawlResult) {
    return {
      event: 'crawl_completed',
      timestamp: new Date().toISOString(),
      website: {
        id: website.id,
        name: website.name,
        url: website.url,
        category: website.category,
      },
      crawl_result: {
        id: crawlResult.id,
        status: crawlResult.status,
        started_at: crawlResult.startedAt,
        completed_at: crawlResult.completedAt,
        total_links_found: crawlResult.totalLinksFound,
        total_links_checked: crawlResult.totalLinksChecked,
        broken_links_found: crawlResult.brokenLinksFound,
        redirects_found: crawlResult.redirectsFound,
        timeouts_found: crawlResult.timeoutsFound,
        average_response_time: crawlResult.averageResponseTime,
        health_score: website.healthScore,
      },
      broken_links: crawlResult.brokenLinks
        ? crawlResult.brokenLinks.slice(0, 10).map((link) => ({
            url: link.url,
            source_url: link.sourceUrl,
            error_type: link.errorType,
            status_code: link.statusCode,
            error_message: link.errorMessage,
          }))
        : [],
    };
  }

  async notifyWebsiteOwner(website, crawlResult) {
    const notifications = [];

    try {
      // Send email notification if configured
      if (website.notificationEmail && this.emailTransporter) {
        const { subject, htmlContent } = this.generateCrawlReportEmail(
          website,
          crawlResult
        );
        const emailResult = await this.sendEmail(
          website.notificationEmail,
          subject,
          htmlContent
        );
        notifications.push({
          type: 'email',
          recipient: website.notificationEmail,
          ...emailResult,
        });
      }

      // Send webhook notification if configured
      if (website.webhookUrl) {
        const webhookPayload = this.generateWebhookPayload(
          website,
          crawlResult
        );
        const webhookResult = await this.sendWebhook(
          website.webhookUrl,
          webhookPayload
        );
        notifications.push({
          type: 'webhook',
          url: website.webhookUrl,
          ...webhookResult,
        });
      }

      return notifications;
    } catch (error) {
      console.error('Notification sending failed:', error);
      return [
        {
          type: 'error',
          error: error.message,
          success: false,
        },
      ];
    }
  }

  stripHtml(html) {
    return html
      .replace(/<[^>]*>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  async testEmailConfiguration() {
    if (!this.emailTransporter) {
      return { success: false, error: 'Email transporter not configured' };
    }

    try {
      await this.emailTransporter.verify();
      return { success: true, message: 'Email configuration is valid' };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
}

module.exports = NotificationService;
