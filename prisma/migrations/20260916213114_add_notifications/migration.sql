-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('PAYMENT', 'VOUCHER', 'SYSTEM');

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL DEFAULT 'PAYMENT',
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "amountMinor" INTEGER,
    "reference" TEXT,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Notification_venueId_idx" ON "Notification"("venueId");

-- CreateIndex
CREATE INDEX "Notification_read_idx" ON "Notification"("read");

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
