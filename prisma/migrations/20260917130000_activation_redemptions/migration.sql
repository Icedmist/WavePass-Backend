-- CreateTable
CREATE TABLE "ActivationRedemption" (
    "id" TEXT NOT NULL,
    "codeId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "venueId" TEXT,
    "redeemedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActivationRedemption_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ActivationRedemption_codeId_email_key" ON "ActivationRedemption"("codeId", "email");

-- CreateIndex
CREATE INDEX "ActivationRedemption_email_idx" ON "ActivationRedemption"("email");

-- AddForeignKey
ALTER TABLE "ActivationRedemption" ADD CONSTRAINT "ActivationRedemption_codeId_fkey" FOREIGN KEY ("codeId") REFERENCES "ActivationCode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: every USED code with a redeemer gets a ledger row so earlier
-- MASTER redeemers keep their activation after the fix ships.
INSERT INTO "ActivationRedemption" ("id", "codeId", "email", "venueId", "redeemedAt")
SELECT gen_random_uuid(), "id", LOWER(TRIM("redeemedBy")), "venueId",
       COALESCE("usedAt", "createdAt", CURRENT_TIMESTAMP)
FROM "ActivationCode"
WHERE "status" = 'USED' AND "redeemedBy" IS NOT NULL AND TRIM("redeemedBy") <> ''
ON CONFLICT ("codeId", "email") DO NOTHING;
