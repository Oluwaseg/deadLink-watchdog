CREATE TABLE "crawl_job_results" (
    "bullJobId" TEXT NOT NULL,
    "crawlResultId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crawl_job_results_pkey" PRIMARY KEY ("bullJobId")
);

CREATE INDEX "crawl_job_results_crawlResultId_idx"
ON "crawl_job_results"("crawlResultId");

-- Keep one historical result per Bull job ID. Prefer completed results, then the most recently updated row.
INSERT INTO "crawl_job_results" ("bullJobId", "crawlResultId")
SELECT DISTINCT ON (legacy."bullJobId")
    legacy."bullJobId",
    legacy."id"
FROM (
    SELECT
        "id",
        "status",
        "updatedAt",
        NULLIF(BTRIM("summary" ->> 'jobId'), '') AS "bullJobId"
    FROM "crawl_results"
) AS legacy
WHERE legacy."bullJobId" IS NOT NULL
ORDER BY
    legacy."bullJobId",
    CASE WHEN legacy."status" = 'completed' THEN 0 ELSE 1 END,
    legacy."updatedAt" DESC,
    legacy."id";

ALTER TABLE "crawl_job_results"
ADD CONSTRAINT "crawl_job_results_crawlResultId_fkey"
FOREIGN KEY ("crawlResultId") REFERENCES "crawl_results"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
