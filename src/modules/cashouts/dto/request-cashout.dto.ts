import {
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Min,
} from 'class-validator';

export class RequestCashoutDto {
  @IsUUID()
  venueId: string;

  @IsNumber({ maxDecimalPlaces: 0 })
  @Min(100) // ≥ ₦1.00 (100 kobo) sanity guard
  amountMinor: number;

  /** Venue owner's password — confirms the cashout is theirs. No admin approval needed if balance covers it. */
  @IsString()
  password: string;

  @IsOptional()
  @IsString()
  reason?: string;

  /** Client-generated idempotency key (uuid). Retried submissions with the
   *  same key return the original cashout instead of double-paying. */
  @IsOptional()
  @IsString()
  clientReference?: string;
}