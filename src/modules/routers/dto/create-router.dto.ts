import { IsEnum, IsOptional, IsString } from 'class-validator';

export class CreateRouterDto {
  @IsString()
  venueId: string;

  @IsString()
  name: string;

  @IsString()
  endpoint: string; // e.g. "http://localhost:3001" or WireGuard IP "http://10.8.0.2:80"

  @IsString()
  connectionMode: string; // local | tunnel

  @IsOptional()
  @IsString()
  rosVersion?: string;
}
