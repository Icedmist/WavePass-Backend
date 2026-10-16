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
  localIp?: string;

  @IsOptional()
  @IsString()
  username?: string;

  @IsOptional()
  @IsString()
  password?: string;

  @IsOptional()
  @IsString()
  tunnelEndpoint?: string;

  @IsOptional()
  @IsString()
  rosVersion?: string;
}
