import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, Min } from 'class-validator';
import { PlanMode } from '@prisma/client';

export class UpdatePlanDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  priceMinor?: number;

  @IsOptional()
  @IsInt()
  @Min(60)
  durationSeconds?: number;

  @IsOptional()
  dataLimitBytes?: number;

  @IsOptional()
  @IsString()
  rateLimit?: string;

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
