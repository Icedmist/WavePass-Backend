-- CreateEnum
CREATE TYPE "ActivationRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'GRANTED');

-- CreateTable
CREATE TABLE "ActivationRequest" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "phone" TEXT,
    "venueName" TEXT,
    "venueId" TEXT,
    "message" TEXT,
    "status" "ActivationRequestStatus" NOT NULL DEFAULT 'PENDING',
    "grantedCodeId" TEXT,
    "grantedUntil" TIMESTAMP(3),
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActivationRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ActivationRequest_status_idx" ON "ActivationRequest"("status");

-- CreateIndex
CREATE INDEX "ActivationRequest_email_idx" ON "ActivationRequest"("email");
