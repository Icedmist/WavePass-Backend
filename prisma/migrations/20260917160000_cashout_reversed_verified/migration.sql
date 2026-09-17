-- AlterEnum (add REVERSED; Postgres requires no transaction workaround here
-- because no existing rows depend on ordering)
ALTER TYPE "CashoutStatus" ADD VALUE 'REVERSED';

-- AlterTable
ALTER TABLE "BankAccount" ADD COLUMN "verifiedAt" TIMESTAMP(3);
