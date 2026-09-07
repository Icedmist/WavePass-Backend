import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
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

import { AdminController } from './modules/admin/admin.controller';
import { AdminService } from './modules/admin/admin.service';
import { AdminAuthService } from './modules/admin/admin-auth.service';
import { AdminAuthGuard } from './modules/admin/admin-auth.guard';

import { VirtualAccountsController } from './modules/virtual-accounts/virtual-accounts.controller';
import { VirtualAccountsService } from './modules/virtual-accounts/virtual-accounts.service';

import { CashoutsController } from './modules/cashouts/cashouts.controller';
import { CashoutsService } from './modules/cashouts/cashouts.service';

import { HealthController } from './modules/health/health.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    JwtModule.register({
      secret: process.env.JWT_SECRET || 'wavepass-change-me-jwt',
      signOptions: { expiresIn: (process.env.ADMIN_JWT_EXPIRES_IN || '2h') as any },
    }),
    ThrottlerModule.forRoot([
      {
        name: 'default',
        ttl: 60000,
        limit: 60,
      },
      {
        name: 'strict',
        ttl: 60000,
        limit: 10,
      },
      {
        name: 'portal',
        ttl: 60000,
        limit: 20,
      },
    ]),
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
    AdminController,
    VirtualAccountsController,
    CashoutsController,
    HealthController,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
    PrismaService,
    PaystackService,
    OrdersService,
    VouchersService,
    PlansService,
    VenuesService,
    RoutersService,
    SessionsService,
    PortalService,
    AdminService,
    AdminAuthService,
    AdminAuthGuard,
    PaymentFulfilmentQueue,
    PaymentFulfilmentProcessor,
    MikrotikProvisioningQueue,
    MikrotikProvisioningProcessor,
    MikrotikAdapter,
    VirtualAccountsService,
    CashoutsService,
  ],
})
export class AppModule {}
