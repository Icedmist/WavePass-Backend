import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { OrdersService } from './orders.service';

@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post()
  create(@Body() body: { venueId: string; planId: string; customerRef?: string }) {
    return this.orders.create(body);
  }

  @Get(':id/status')
  status(@Param('id') id: string) {
    return this.orders.status(id);
  }
}
