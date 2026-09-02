import { IsOptional, IsString, Matches } from 'class-validator';

export class InitPaymentDto {
  @IsString()
  @Matches(/^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$/, {
    message: 'mac must be a valid MAC address in format AA:BB:CC:DD:EE:FF',
  })
  mac: string;

  @IsString()
  planId: string;

  @IsOptional()
  @IsString()
  email?: string;

  @IsOptional()
  @IsString()
  venueId?: string;
}
