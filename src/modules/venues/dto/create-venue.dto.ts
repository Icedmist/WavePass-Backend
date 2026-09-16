import { IsNotEmpty, IsOptional, IsString, Matches } from 'class-validator';

export class CreateVenueDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsString()
  @Matches(/^[a-z0-9-]+$/, { message: 'slug must be lowercase a-z, 0-9, hyphen and will be used as subdomain (e.g. my-venue.nexawavepass.com)' })
  slug: string;

  @IsOptional()
  @IsString()
  timezone?: string;

  @IsOptional()
  @IsString()
  currency?: string;

  @IsOptional()
  @IsString()
  logoUrl?: string;
}
