const fs = require('fs');
const path = require('path');
const handlebars = require('handlebars');
const nodemailer = require('nodemailer');
const config = require('../../config/config');

class EmailService {
  constructor() {
    this.fromEmail = config.email.from;
    this.fromName = config.email.fromName || 'DeadLink Watchdog';
    this.transport = null;
    this.templates = {};

    this.initializeTransporter();
    this.loadTemplates();
  }

  initializeTransporter() {
    const emailConfig = config.email;
    const env = process.env.NODE_ENV || 'development';

    if (env === 'development') {
      this.transport = nodemailer.createTransport({
        host: process.env.MAILHOG_HOST || 'localhost',
        port: Number(process.env.MAILHOG_PORT) || 1025,
        secure: false,
      });
      console.log('Using MailHog transport for development email delivery');
      return;
    }

    if (emailConfig.user && emailConfig.password) {
      this.transport = nodemailer.createTransport({
        host: emailConfig.host,
        port: Number(emailConfig.port) || 587,
        secure: Number(emailConfig.port) === 465,
        auth: {
          user: emailConfig.user,
          pass: emailConfig.password,
        },
      });
      return;
    }

    console.warn(
      'Email transporter not configured - missing SMTP credentials for production'
    );
  }

  loadTemplates() {
    const templatesDir = path.join(__dirname, '../templates/email');
    const templateFiles = [
      'verification-email.hbs',
      'password-reset-email.hbs',
      'welcome-email.hbs',
      'crawl-notification-email.hbs',
    ];

    templateFiles.forEach((fileName) => {
      try {
        const filePath = path.join(templatesDir, fileName);
        const fileContents = fs.readFileSync(filePath, 'utf8');
        const templateName = path.basename(fileName, '.hbs');
        this.templates[templateName] = handlebars.compile(fileContents);
      } catch (error) {
        console.warn(
          `Unable to load email template ${fileName}: ${error.message}`
        );
      }
    });
  }

  renderTemplate(templateName, context = {}) {
    const template = this.templates[templateName];
    if (!template) {
      console.error(`Missing email template: ${templateName}`);
      return '';
    }
    return template({
      appName: this.fromName,
      ...context,
    });
  }

  stripHtml(html) {
    return html
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  async sendMail({ to, subject, templateName, context = {} }) {
    if (!this.transport) {
      console.warn('Email transport is not configured');
      return { success: false, message: 'Email transport is not configured' };
    }

    const html = this.renderTemplate(templateName, context);
    if (!html) {
      return { success: false, message: 'Email template rendering failed' };
    }

    const mailOptions = {
      from: `${this.fromName} <${this.fromEmail}>`,
      to,
      subject,
      html,
      text: this.stripHtml(html),
    };

    try {
      const result = await this.transport.sendMail(mailOptions);
      return {
        success: true,
        messageId: result.messageId,
      };
    } catch (error) {
      console.error('Failed to send email:', error);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  async sendVerificationEmail(email, verificationCode, firstName) {
    return this.sendMail({
      to: email,
      subject: `Verify your email for ${this.fromName}`,
      templateName: 'verification-email',
      context: {
        firstName: firstName || 'there',
        verificationCode,
        expiryHours: '24',
      },
    });
  }

  async sendPasswordResetEmail(email, resetToken, firstName) {
    const resetUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/reset-password?token=${resetToken}`;
    return this.sendMail({
      to: email,
      subject: `Reset your ${this.fromName} password`,
      templateName: 'password-reset-email',
      context: {
        firstName: firstName || 'there',
        resetUrl,
        expiryHours: '1',
      },
    });
  }

  async sendWelcomeEmail(email, firstName) {
    return this.sendMail({
      to: email,
      subject: `Welcome to ${this.fromName}`,
      templateName: 'welcome-email',
      context: {
        firstName: firstName || 'there',
      },
    });
  }

  async sendCrawlNotification(
    email,
    website,
    crawlResult,
    firstName,
    brokenLinks = []
  ) {
    const healthScore = Number(website.healthScore ?? 0);
    return this.sendMail({
      to: email,
      subject:
        crawlResult.brokenLinksFound > 0
          ? `🚨 ${crawlResult.brokenLinksFound} Broken Links Found on ${website.name}`
          : `✅ Crawl Report for ${website.name}`,
      templateName: 'crawl-notification-email',
      context: {
        firstName: firstName || 'there',
        websiteName: website.name,
        websiteUrl: website.url,
        crawlDate: crawlResult.completedAt || new Date(),
        totalLinksChecked: crawlResult.totalLinksChecked,
        brokenLinksFound: crawlResult.brokenLinksFound,
        healthScore,
        statusMessage:
          crawlResult.brokenLinksFound > 0
            ? `Action required: ${crawlResult.brokenLinksFound} broken links were found.`
            : 'Great news! No broken links were found during this crawl.',
        brokenLinks,
      },
    });
  }
}

module.exports = new EmailService();
