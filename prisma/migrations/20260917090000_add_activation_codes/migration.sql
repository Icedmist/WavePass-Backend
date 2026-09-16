-- CreateEnum
CREATE TYPE "ActivationCodeStatus" AS ENUM ('PENDING', 'AUTHORIZED', 'USED', 'REVOKED', 'EXPIRED');

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- CreateTable
CREATE TABLE "ActivationCode" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "status" "ActivationCodeStatus" NOT NULL DEFAULT 'AUTHORIZED',
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "authorizedAt" TIMESTAMP(3),
    "redeemedBy" TEXT,
    "venueId" TEXT,
    "usedAt" TIMESTAMP(3),
    "quota" INTEGER NOT NULL DEFAULT 1,
    "usedCount" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3),
    "notes" TEXT,

    CONSTRAINT "ActivationCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ActivationCode_code_key" ON "ActivationCode"("code");

-- CreateIndex
CREATE INDEX "ActivationCode_status_idx" ON "ActivationCode"("status");

-- CreateIndex
CREATE INDEX "ActivationCode_venueId_idx" ON "ActivationCode"("venueId");

-- Seed legacy rollout codes (idempotent)
INSERT INTO "ActivationCode" ("id", "code", "status", "createdBy", "createdAt", "authorizedAt", "quota", "usedCount", "notes")
VALUES
  (gen_random_uuid(), 'WP-ACT-NEXA-2025', 'AUTHORIZED', 'talk2icedmist@gmail.com', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1, 0, 'Master activation code for initial system rollout'),
  (gen_random_uuid(), 'WP-ACT-VIP-8899', 'AUTHORIZED', 'talk2icedmist@gmail.com', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 1, 0, 'Production rollout voucher activation')
ON CONFLICT ("code") DO NOTHING;
