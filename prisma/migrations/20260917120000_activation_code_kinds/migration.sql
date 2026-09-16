-- CreateEnum
CREATE TYPE "ActivationCodeKind" AS ENUM ('LICENSE', 'MASTER', 'TRIAL');

-- AlterTable
ALTER TABLE "ActivationCode" ADD COLUMN "kind" "ActivationCodeKind" NOT NULL DEFAULT 'LICENSE';

-- CreateIndex
CREATE INDEX "ActivationCode_kind_idx" ON "ActivationCode"("kind");
