import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, Min } from 'class-validator';
import { PlanMode } from '@prisma/client';

export class CreatePlanDto {
  @IsString()
  venueId: string;

  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsInt()
  @Min(1)
  priceMinor: number; // e.g. 20000 kobo for 200 NGN

  @IsInt()
  @Min(60)
  durationSeconds: number; // duration in seconds

  @IsOptional()
  dataLimitBytes?: number;

  @IsOptional()
  @IsString()
  rateLimit?: string; // e.g. "5M/2M"

  @IsOptional()
  @IsInt()
  @Min(1)
  simultaneousDevices?: number;

  @IsOptional()
  @IsEnum(PlanMode)
  mode?: PlanMode;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
