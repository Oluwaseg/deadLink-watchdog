const axios = require('axios');

class EmailService {
  constructor() {
    this.apiKey = process.env.BREVO_API_KEY;
    this.fromEmail = process.env.FROM_EMAIL || 'noreply@deadlinkwatchdog.com';
    this.fromName = process.env.FROM_NAME || 'DeadLink Watchdog';
    this.apiUrl = 'https://api.brevo.com/v3';

    // Create axios instance with default headers
    this.brevoClient = axios.create({
      baseURL: this.apiUrl,
      headers: {
        'api-key': this.apiKey,
        'Content-Type': 'application/json',
      },
    });
  }

  async sendTemplateEmail(templateId, email, firstName, params = {}) {
    if (!this.apiKey) {
      console.warn('Brevo API key not configured, skipping email send');
      return { success: false, message: 'Email service not configured' };
    }

    if (!templateId) {
      console.error('Template ID is required');
      return { success: false, message: 'Template ID is required' };
    }

    try {
      const emailData = {
        to: [{ email, name: firstName }],
        templateId: parseInt(templateId),
        params: {
          FIRSTNAME: firstName,
          APP_NAME: 'DeadLink Watchdog',
          ...params,
        },
        sender: {
          name: this.fromName,
          email: this.fromEmail,
        },
      };

      console.log(`📧 Sending template ${templateId} to ${email}`);

      const response = await this.brevoClient.post('/smtp/email', emailData);

      console.log(`✅ Email sent successfully to ${email}`);
      return { success: true, messageId: response.data.messageId };
    } catch (error) {
      console.error(
        'Failed to send email:',
        error.response?.data || error.message
      );
      return {
        success: false,
        error: error.response?.data?.message || error.message,
      };
    }
  }

  async sendVerificationEmail(email, verificationCode, firstName) {
    const templateId = process.env.BREVO_VERIFICATION_TEMPLATE_ID;
    return await this.sendTemplateEmail(templateId, email, firstName, {
      VERIFICATION_CODE: verificationCode,
      EXPIRY_HOURS: '24',
    });
  }

  async sendPasswordResetEmail(email, resetToken, firstName) {
    const templateId = process.env.BREVO_PASSWORD_RESET_TEMPLATE_ID;
    const resetUrl = `${
      process.env.FRONTEND_URL || 'http://localhost:3000'
    }/reset-password?token=${resetToken}`;

    return await this.sendTemplateEmail(templateId, email, firstName, {
      RESET_URL: resetUrl,
      EXPIRY_HOURS: '1',
    });
  }

  async sendCrawlNotification(email, website, crawlResult,firstName) {
    const templateId = process.env.BREVO_CRAWL_NOTIFICATION_TEMPLATE_ID;

    return await this.sendTemplateEmail(templateId, email, firstName, {
      WEBSITE_NAME: website.name,
      WEBSITE_URL: website.url,
      TOTAL_LINKS: crawlResult.totalLinksChecked,
      BROKEN_LINKS: crawlResult.brokenLinksFound,
      HEALTH_SCORE: website.healthScore,
      STATUS_MESSAGE:
        crawlResult.brokenLinksFound > 0
          ? `⚠️ Action Required: ${crawlResult.brokenLinksFound} broken links found`
          : '✅ Great News: No broken links found',
    });
  }

  async sendWelcomeEmail(email, firstName) {
    const templateId = process.env.BREVO_WELCOME_TEMPLATE_ID;
    return await this.sendTemplateEmail(templateId, email, firstName);
  }
}

module.exports = new EmailService();
