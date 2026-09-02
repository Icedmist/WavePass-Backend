import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { PrismaService } from './common/prisma.service';

import { PaystackController } from './modules/paystack/paystack.controller';
import { PaystackService } from './modules/paystack/paystack.service';

import { OrdersController } from './modules/orders/orders.controller';
import { OrdersService } from './modules/orders/orders.service';

import { VouchersController } from './modules/vouchers/vouchers.controller';
import { VouchersService } from './modules/vouchers/vouchers.service';

import { PaymentFulfilmentQueue } from './modules/jobs/payment-fulfilment.queue';
import { PaymentFulfilmentProcessor } from './modules/jobs/payment-fulfilment.processor';

import { MikrotikProvisioningQueue } from './modules/mikrotik/mikrotik-provisioning.queue';
import { MikrotikProvisioningProcessor } from './modules/mikrotik/mikrotik-provisioning.processor';
import { MikrotikAdapter } from './modules/mikrotik/mikrotik.adapter';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    BullModule.forRoot({
      connection: { url: process.env.REDIS_URL || 'redis://localhost:6379' },
    }),
    BullModule.registerQueue(
      { name: 'payment-fulfilment' },
      { name: 'mikrotik-provisioning' },
    ),
  ],
  controllers: [PaystackController, OrdersController, VouchersController],
  providers: [
    PrismaService,
    PaystackService,
    OrdersService,
    VouchersService,
    PaymentFulfilmentQueue,
    PaymentFulfilmentProcessor,
    MikrotikProvisioningQueue,
    MikrotikProvisioningProcessor,
    MikrotikAdapter,
  ],
})
export class AppModule {}
