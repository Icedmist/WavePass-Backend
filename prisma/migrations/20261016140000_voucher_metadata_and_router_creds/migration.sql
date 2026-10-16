-- AlterTable
ALTER TABLE "Router" ADD COLUMN "localIp" TEXT,
ADD COLUMN "username" TEXT,
ADD COLUMN "password" TEXT,
ADD COLUMN "tunnelEndpoint" TEXT;

-- AlterTable
ALTER TABLE "Voucher" ADD COLUMN "password" TEXT,
ADD COLUMN "sold" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "soldAt" TIMESTAMP(3),
ADD COLUMN "source" TEXT,
ADD COLUMN "directMode" TEXT;

-- CreateIndex
CREATE INDEX "Voucher_sold_idx" ON "Voucher"("sold");
