import { Body, Controller, Param, Post } from '@nestjs/common';
import { VouchersService } from './vouchers.service';

@Controller('vouchers')
export class VouchersController {
  constructor(private readonly vouchers: VouchersService) {}

  @Post('batches')
  generateBatch(
    @Body() body: { venueId: string; planId: string; quantity: number; expiresAt?: string; createdBy?: string },
  ) {
    return this.vouchers.generateBatch({
      ...body,
      expiresAt: body.expiresAt ? new Date(body.expiresAt) : undefined,
    });
  }

  @Post(':code/redeem')
  redeem(
    @Param('code') code: string,
    @Body() body: { routerId: string; deviceId?: string; ip?: string; mac?: string },
  ) {
    return this.vouchers.redeem(code, body);
  }

  @Post(':id/revoke')
  revoke(@Param('id') id: string) {
    return this.vouchers.revoke(id);
  }
}
