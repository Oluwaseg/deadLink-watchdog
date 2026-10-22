-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('user', 'admin');

-- CreateEnum
CREATE TYPE "WebsiteCategory" AS ENUM ('news', 'government', 'business', 'education', 'entertainment', 'financial', 'other');

-- CreateEnum
CREATE TYPE "CrawlFrequency" AS ENUM ('daily', 'weekly', 'monthly');

-- CreateEnum
CREATE TYPE "CrawlStatus" AS ENUM ('pending', 'running', 'completed', 'failed');

-- CreateEnum
CREATE TYPE "ErrorType" AS ENUM ('404_not_found', '403_forbidden', '500_server_error', 'timeout', 'connection_refused', 'dns_error', 'ssl_error', 'redirect_loop', 'too_many_redirects', 'other');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'user',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "emailVerificationCode" TEXT,
    "emailVerificationExpires" TIMESTAMP(3),
    "lastLoginAt" TIMESTAMP(3),
    "resetPasswordToken" TEXT,
    "resetPasswordExpires" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "websites" (
    "id" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" "WebsiteCategory" NOT NULL DEFAULT 'other',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "crawlFrequency" "CrawlFrequency",
    "lastCrawledAt" TIMESTAMP(3),
    "nextCrawlAt" TIMESTAMP(3),
    "totalLinks" INTEGER NOT NULL DEFAULT 0,
    "brokenLinks" INTEGER NOT NULL DEFAULT 0,
    "healthScore" DOUBLE PRECISION NOT NULL DEFAULT 100,
    "notificationEmail" TEXT,
    "webhookUrl" TEXT,
    "isFlagged" BOOLEAN NOT NULL DEFAULT false,
    "reports" INTEGER NOT NULL DEFAULT 0,
    "moderatedAt" TIMESTAMP(3),
    "moderatedBy" UUID,
    "userId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "websites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crawl_results" (
    "id" UUID NOT NULL,
    "websiteId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "status" "CrawlStatus" NOT NULL DEFAULT 'pending',
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "totalLinksFound" INTEGER NOT NULL DEFAULT 0,
    "totalLinksChecked" INTEGER NOT NULL DEFAULT 0,
    "brokenLinksFound" INTEGER NOT NULL DEFAULT 0,
    "redirectsFound" INTEGER NOT NULL DEFAULT 0,
    "timeoutsFound" INTEGER NOT NULL DEFAULT 0,
    "averageResponseTime" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "crawlDepth" INTEGER NOT NULL DEFAULT 1,
    "userAgent" TEXT,
    "summary" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "crawl_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "broken_links" (
    "id" UUID NOT NULL,
    "websiteId" UUID NOT NULL,
    "crawlResultId" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "linkText" TEXT,
    "statusCode" INTEGER,
    "errorType" "ErrorType" NOT NULL,
    "errorMessage" TEXT,
    "responseTime" INTEGER,
    "redirectChain" JSONB NOT NULL DEFAULT '[]',
    "isFixed" BOOLEAN NOT NULL DEFAULT false,
    "fixedAt" TIMESTAMP(3),
    "firstDetectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastCheckedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "checkCount" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "broken_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_role_idx" ON "users"("role");

-- CreateIndex
CREATE INDEX "users_isActive_idx" ON "users"("isActive");

-- CreateIndex
CREATE INDEX "websites_userId_idx" ON "websites"("userId");

-- CreateIndex
CREATE INDEX "websites_isActive_idx" ON "websites"("isActive");

-- CreateIndex
CREATE INDEX "websites_nextCrawlAt_idx" ON "websites"("nextCrawlAt");

-- CreateIndex
CREATE INDEX "websites_category_idx" ON "websites"("category");

-- CreateIndex
CREATE INDEX "crawl_results_websiteId_idx" ON "crawl_results"("websiteId");

-- CreateIndex
CREATE INDEX "crawl_results_userId_idx" ON "crawl_results"("userId");

-- CreateIndex
CREATE INDEX "crawl_results_status_idx" ON "crawl_results"("status");

-- CreateIndex
CREATE INDEX "crawl_results_createdAt_idx" ON "crawl_results"("createdAt");

-- CreateIndex
CREATE INDEX "broken_links_websiteId_idx" ON "broken_links"("websiteId");

-- CreateIndex
CREATE INDEX "broken_links_crawlResultId_idx" ON "broken_links"("crawlResultId");

-- CreateIndex
CREATE INDEX "broken_links_errorType_idx" ON "broken_links"("errorType");

-- CreateIndex
CREATE INDEX "broken_links_isFixed_idx" ON "broken_links"("isFixed");

-- AddForeignKey
ALTER TABLE "websites" ADD CONSTRAINT "websites_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "websites" ADD CONSTRAINT "websites_moderatedBy_fkey" FOREIGN KEY ("moderatedBy") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crawl_results" ADD CONSTRAINT "crawl_results_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "websites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crawl_results" ADD CONSTRAINT "crawl_results_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "broken_links" ADD CONSTRAINT "broken_links_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "websites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "broken_links" ADD CONSTRAINT "broken_links_crawlResultId_fkey" FOREIGN KEY ("crawlResultId") REFERENCES "crawl_results"("id") ON DELETE CASCADE ON UPDATE CASCADE;
