import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { VouchersService } from './vouchers.service';

@Controller('vouchers')
export class VouchersController {
  constructor(private readonly vouchers: VouchersService) {}

  @Post('batches')
  generateBatch(
    @Body()
    body: {
      venueId: string;
      planId: string;
      quantity: number;
      customCode?: string;
      customCodes?: string[];
      password?: string;
      passwords?: string[];
      sold?: boolean;
      source?: string;
      directMode?: string;
      expiresAt?: string;
      createdBy?: string;
    },
  ) {
    return this.vouchers.generateBatch({
      ...body,
      expiresAt: body.expiresAt ? new Date(body.expiresAt) : undefined,
    });
  }

  @Post('sync')
  sync(
    @Body()
    body: {
      venueId: string;
      vouchers: Array<{
        code: string;
        password?: string;
        planId?: string;
        planTitle?: string;
        price?: string;
        durationSeconds?: number;
        status?: string;
        sold?: boolean;
        soldAt?: string;
        source?: string;
        directMode?: boolean | string;
        createdAt?: string;
        expiresAt?: string;
        mac?: string;
        ip?: string;
      }>;
    },
  ) {
    return this.vouchers.syncVouchers(body);
  }

  @Patch(':code/sold')
  markSold(
    @Param('code') code: string,
    @Body() body: { sold: boolean },
  ) {
    return this.vouchers.markSold(code, body.sold ?? true);
  }

  @Get('check/:code')
  check(@Param('code') code: string) {
    return this.vouchers.check(code);
  }

  @Get()
  list(@Query('venueId') venueId?: string) {
    return this.vouchers.listByVenue(venueId || '');
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
