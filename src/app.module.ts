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

import { PlansController } from './modules/plans/plans.controller';
import { PlansService } from './modules/plans/plans.service';

import { VenuesController } from './modules/venues/venues.controller';
import { VenuesService } from './modules/venues/venues.service';

import { RoutersController } from './modules/routers/routers.controller';
import { RoutersService } from './modules/routers/routers.service';

import { SessionsController } from './modules/sessions/sessions.controller';
import { SessionsService } from './modules/sessions/sessions.service';

import { PortalController } from './modules/portal/portal.controller';
import { PortalService } from './modules/portal/portal.service';

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
  controllers: [
    PaystackController,
    OrdersController,
    VouchersController,
    PlansController,
    VenuesController,
    RoutersController,
    SessionsController,
    PortalController,
  ],
  providers: [
    PrismaService,
    PaystackService,
    OrdersService,
    VouchersService,
    PlansService,
    VenuesService,
    RoutersService,
    SessionsService,
    PortalService,
    PaymentFulfilmentQueue,
    PaymentFulfilmentProcessor,
    MikrotikProvisioningQueue,
    MikrotikProvisioningProcessor,
    MikrotikAdapter,
  ],
})
export class AppModule {}
