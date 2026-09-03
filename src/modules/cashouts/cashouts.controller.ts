import { Body, Controller, Get, Param, Post, Query, ValidationPipe } from '@nestjs/common';
import { CashoutsService } from './cashouts.service';
import { RequestCashoutDto } from './dto/request-cashout.dto';
import { ConfirmCashoutDto } from './dto/confirm-cashout.dto';
import { RegisterBankAccountDto } from './dto/register-bank-account.dto';

@Controller('cashouts')
export class CashoutsController {
  constructor(private readonly cashouts: CashoutsService) {}

  @Get('balance/:venueId')
  balance(@Param('venueId') venueId: string) {
    return this.cashouts.venueBalance(venueId);
  }

  @Post('bank-accounts')
  registerBank(
    @Body(new ValidationPipe({ whitelist: true, transform: true })) dto: RegisterBankAccountDto,
  ) {
    return this.cashouts.registerBankAccount(dto);
  }

  @Get('bank-accounts')
  listBank(@Query('venueId') venueId: string) {
    return this.cashouts.listBankAccounts(venueId);
  }

  /** Auto-cashout: venue owner confirms with their own password and funds move immediately. */
  @Post()
  request(
    @Body(new ValidationPipe({ whitelist: true, transform: true })) dto: RequestCashoutDto,
  ) {
    return this.cashouts.requestCashout(dto);
  }

  /** Back-compat: confirm a previously-pending cashout with owner/admin password. */
  @Post('confirm')
  confirm(
    @Body(new ValidationPipe({ whitelist: true, transform: true })) dto: ConfirmCashoutDto,
  ) {
    return this.cashouts.confirmCashout(dto, dto.adminPassword);
  }

  @Post(':id/reject')
  reject(
    @Param('id') id: string,
    @Body() body: { adminPassword: string; reason?: string },
  ) {
    return this.cashouts.rejectCashout(id, body.adminPassword, body.reason);
  }

  @Get()
  list(@Query('venueId') venueId: string) {
    return this.cashouts.listByVenue(venueId);
  }
}