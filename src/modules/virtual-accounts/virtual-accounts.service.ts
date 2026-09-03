import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { PaystackService } from '../paystack/paystack.service';
import { VenuesService } from '../venues/venues.service';
import { CreateVirtualAccountDto } from './dto/create-virtual-account.dto';

/**
 * Single-key model: the platform (Nexa) owns ONE Paystack secret key. Each venue
 * is given a dedicated virtual account (DVA) so payments from guests on that
 * venue settle into the platform settlement account — no per-merchant keys.
 */
@Injectable()
export class VirtualAccountsService {
  private readonly logger = new Logger(VirtualAccountsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly paystack: PaystackService,
    private readonly venuesService: VenuesService,
  ) {}

  async getForVenue(venueId: string) {
    return this.prisma.virtualAccount.findUnique({
      where: { venueId },
      include: { venue: { select: { id: true, name: true } } },
    });
  }

  async getById(id: string) {
    const va = await this.prisma.virtualAccount.findUnique({
      where: { id },
      include: { venue: { select: { id: true, name: true } } },
    });
    if (!va) throw new NotFoundException(`Virtual account ${id} not found`);
    return va;
  }

  private likelyMailTo(venueName: string): string {
    const slug = venueName.toLowerCase().replace(/[^a-z0-9]+/g, '.');
    return `venue.${slug || 'wavepass'}@nexa-pay.local`;
  }

  /** Ensure a DVA exists for a venue — idempotent. */
  async ensureForVenue(venueId: string, opts?: { email?: string; preferredBank?: string }) {
    const existing = await this.prisma.virtualAccount.findUnique({ where: { venueId } });
    if (existing) return existing;

    const venue = await this.venuesService.getVenueById(venueId);
    if (this.paystack.isMock()) {
      return this.createMock(venue.id, venue.name);
    }

    const email = opts?.email || this.likelyMailTo(venue.name);

    let customer: { customer_code: string };
    try {
      const existingCustomer = await this.prisma.virtualAccount.findFirst({
        where: { customerCode: { not: null } },
      });
      customer = existingCustomer
        ? { customer_code: existingCustomer.customerCode! }
        : await this.paystack.createCustomer(email, { first_name: venue.name });
    } catch (err) {
      customer = await this.paystack.createCustomer(email, { first_name: venue.name });
    }

    const dva = await this.paystack.createDedicatedAccount({
      customer: customer.customer_code,
      preferredBank: opts?.preferredBank,
      metadata: { venueId: venue.id, venueSlug: venue.slug, platform: 'nexa-wavepass' },
    });

    if (!dva.account_number) {
      throw new ConflictException(
        'Paystack did not return an account number — DVA may be pending allocation.',
      );
    }

    return this.prisma.virtualAccount.create({
      data: {
        venueId: venue.id,
        customerCode: customer.customer_code,
        accountNumber: String(dva.account_number),
        accountName: dva.account_name || venue.name,
        bankName: dva.bank?.name,
        splitCode: (dva as any).split_code || undefined,
        status: 'ACTIVE',
        metadata: { providerId: dva.id },
      },
    });
  }

  /** Signed-in cash-pass sellers can top-up a venue's DVA on the app admin panel. */
  async createVirtualAccount(dto: CreateVirtualAccountDto) {
    if (this.paystack.isMock()) {
      const venue = await this.venuesService.getVenueById(dto.venueId);
      return this.createMock(venue.id, venue.name);
    }
    return this.ensureForVenue(dto.venueId, {
      email: dto.email,
      preferredBank: dto.preferredBank,
    });
  }

  private async createMock(venueId: string, venueName: string) {
    const mockAccountNumber = `9${String(Math.floor(100000000 + Math.random() * 900000000))}`;
    const existing = await this.prisma.virtualAccount.findUnique({ where: { venueId } });
    if (existing) return existing;
    return this.prisma.virtualAccount.create({
      data: {
        venueId,
        accountNumber: mockAccountNumber,
        accountName: venueName,
        bankName: 'Wema Bank (mock)',
        status: 'ACTIVE',
        metadata: { mock: true },
      },
    });
  }
}