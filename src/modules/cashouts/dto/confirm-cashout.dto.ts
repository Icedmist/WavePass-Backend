import { IsOptional, IsString, IsUUID } from 'class-validator';

export class ConfirmCashoutDto {
  @IsUUID()
  cashoutId: string;

  /** Owner/admin password — authorises the payout before a transfer is initiated. */
  @IsString()
  adminPassword: string;

  @IsOptional()
  @IsString()
  adminId?: string;
}