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

  private likelyMailTo(venue: { id: string; slug?: string; name: string }): string {
    const slug = (venue.slug || venue.name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    const shortId = venue.id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8);
    return `venue.${slug || 'wp'}.${shortId}@nexawavepass.com`;
  }

  /** Stale rows from the mock era (or failed activations) must never shadow
   *  a real Paystack DVA once live keys are configured. */
  private isMockRow(row: any): boolean {
    if (!row) return false;
    const meta = row.metadata as any;
    if (meta && (meta.mock === true || meta.mock?.toString() === 'true')) return true;
    const bank = (row.bankName || '').toString().toLowerCase();
    if (bank.includes('mock')) return true;
    if (!row.accountNumber || row.accountNumber === 'PENDING') return true;
    return false;
  }

  /** Ensure a DVA exists for a venue — idempotent and race-safe. PENDING rows
   *  from earlier failed attempts and collided accounts are retried instead of returned forever. */
  async ensureForVenue(venueId: string, opts?: { email?: string; phone?: string; preferredBank?: string }) {
    const existing = await this.prisma.virtualAccount.findUnique({ where: { venueId } });

    // Check if another venue already claims this account number (shared/collided DVA from duplicate venue names)
    const isCollidedWithAnotherVenue =
      existing &&
      existing.accountNumber &&
      existing.accountNumber !== 'PENDING' &&
      !this.paystack.isMock()
        ? await this.prisma.virtualAccount.findFirst({
            where: {
              accountNumber: existing.accountNumber,
              venueId: { not: venueId },
            },
          })
        : null;

    if (
      existing &&
      existing.status === 'ACTIVE' &&
      !isCollidedWithAnotherVenue &&
      (this.paystack.isMock() || !this.isMockRow(existing))
    ) {
      return existing;
    }

    if (
      existing &&
      (this.isMockRow(existing) || isCollidedWithAnotherVenue) &&
      !this.paystack.isMock()
    ) {
      // Stale mock-era, PENDING row, or collided DVA from duplicate names: drop it
      // so a real, unique Paystack DVA takes its place.
      try {
        await this.prisma.virtualAccount.delete({ where: { venueId } });
      } catch (err: any) {
        if (err.code !== 'P2025') throw err;
      }
      this.logger.log(
        `Removed stale/collided DVA for venue ${venueId}; provisioning a dedicated one.`,
      );
    } else if (existing && this.paystack.isMock()) {
      return existing;
    }

    const venue = await this.venuesService.getVenueById(venueId);
    if (this.paystack.isMock()) {
      return this.createMock(venue.id, venue.name);
    }

    const email = opts?.email || this.likelyMailTo(venue);

    // Format first_name, last_name, and phone required by CBN / Paystack DVA compliance
    const parts = (venue.name || 'WavePass Venue').trim().split(/\s+/);
    const firstName = parts[0] || 'WavePass';
    const lastName = parts.slice(1).join(' ') || 'Venue';
    const rawPhone = opts?.phone || process.env.SUPPORT_PHONE || '+2348012345678';
    const cleanPhone = rawPhone.startsWith('+')
      ? rawPhone
      : rawPhone.startsWith('0')
        ? `+234${rawPhone.slice(1)}`
        : `+234${rawPhone}`;

    let customer: { customer_code: string };
    try {
      const cust = await this.paystack.createCustomer(email, {
        first_name: firstName,
        last_name: lastName,
        phone: cleanPhone,
      });
      customer = { customer_code: cust.customer_code };
    } catch (custErr: any) {
      this.logger.warn(`Could not create/retrieve customer on Paystack: ${custErr.message}`);
      customer = { customer_code: `cus_local_${venue.id.slice(0, 8)}` };
    }

    let dva: any = null;
    try {
      dva = await this.paystack.createDedicatedAccount({
        customer: customer.customer_code,
        preferredBank: opts?.preferredBank || 'wema-bank',
        metadata: { venueId: venue.id, venueSlug: venue.slug, platform: 'nexa-wavepass' },
      });
    } catch (dvaErr: any) {
      this.logger.warn(`Dedicated account creation on Paystack skipped/failed: ${dvaErr.message}`);
    }

    if (!dva || !dva.account_number) {
      return this.upsertPending(venue.id, venue.name, customer.customer_code);
    }

    return this.upsertActive(venue.id, {
      customerCode: customer.customer_code,
      accountNumber: String(dva.account_number),
      accountName: dva.account_name || venue.name,
      bankName: dva.bank?.name || 'Wema Bank',
      splitCode: (dva as any).split_code || undefined,
      status: 'ACTIVE',
      metadata: { providerId: dva.id, bankSlug: dva.bank?.slug || 'wema-bank' },
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
      phone: dto.phone,
      preferredBank: dto.preferredBank,
    });
  }

  /** PENDING placeholder that later retries overwrite via upsertActive. */
  private async upsertPending(venueId: string, venueName: string, customerCode: string) {
    try {
      return await this.prisma.virtualAccount.create({
        data: {
          venueId,
          customerCode,
          accountNumber: 'PENDING',
          accountName: venueName,
          bankName: 'Paystack Dedicated NUBAN (Pending)',
          status: 'PENDING',
          metadata: { note: 'DVA pending activation or KYC on Paystack' },
        },
      });
    } catch (err: any) {
      if (err.code !== 'P2002') throw err;
      return this.prisma.virtualAccount.update({
        where: { venueId },
        data: {
          customerCode,
          status: 'PENDING',
          metadata: { note: 'DVA pending activation or KYC on Paystack' },
        },
      });
    }
  }

  private async upsertActive(venueId: string, data: any) {
    try {
      return await this.prisma.virtualAccount.create({ data: { venueId, ...data } });
    } catch (err: any) {
      if (err.code !== 'P2002') throw err;
      // A PENDING row (or a racer's row) already exists — upgrade it in place.
      return this.prisma.virtualAccount.update({ where: { venueId }, data });
    }
  }

  private async createMock(venueId: string, venueName: string) {
    const mockAccountNumber = `9${String(Math.floor(100000000 + Math.random() * 900000000))}`;
    const existing = await this.prisma.virtualAccount.findUnique({ where: { venueId } });
    if (existing) return existing;
    try {
      return await this.prisma.virtualAccount.create({
        data: {
          venueId,
          accountNumber: mockAccountNumber,
          accountName: venueName,
          bankName: 'Wema Bank (mock)',
          status: 'ACTIVE',
          metadata: { mock: true },
        },
      });
    } catch (err: any) {
      if (err.code !== 'P2002') throw err;
      return this.prisma.virtualAccount.findUniqueOrThrow({ where: { venueId } });
    }
  }
}