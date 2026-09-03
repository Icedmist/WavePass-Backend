import { IsEmail, IsOptional, IsString, IsUUID } from 'class-validator';

export class CreateVirtualAccountDto {
  @IsUUID()
  venueId: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  preferredBank?: string;
}