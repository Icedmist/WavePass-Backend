import { IsOptional, IsString } from 'class-validator';

export class RegisterBankAccountDto {
  @IsString()
  venueId: string;

  @IsString()
  accountName: string;

  @IsString()
  accountNumber: string;

  @IsString()
  bankCode: string;

  @IsOptional()
  @IsString()
  bankName?: string;
}