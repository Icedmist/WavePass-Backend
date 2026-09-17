-- AlterTable
ALTER TABLE "Cashout" ADD COLUMN "clientReference" TEXT;

-- CreateIndex (unique, nullable: multiple NULLs allowed, non-null refs dedupe retries)
CREATE UNIQUE INDEX "Cashout_clientReference_key" ON "Cashout"("clientReference");
