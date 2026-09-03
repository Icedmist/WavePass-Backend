import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, timingSafeEqual } from 'crypto';
import { PrismaService } from '../../common/prisma.service';
import { PaystackService } from '../paystack/paystack.service';
import { RequestCashoutDto } from './dto/request-cashout.dto';
import { ConfirmCashoutDto } from './dto/confirm-cashout.dto';
import { RegisterBankAccountDto } from './dto/register-bank-account.dto';

/**
 * Cashout: the venue owner accumulates revenue in their DVA (settled into the
 * single platform/Nexa account). As long as the requested amount is within
 * their available balance, they can cash out automatically by confirming
 * **their own** password — no admin approval queue.
 */
@Injectable()
export class CashoutsService {
  private readonly logger = new Logger(CashoutsService.name);
  private readonly cashoutPasswordHash =
    process.env.ADMIN_PASSWORD_HASH ||
    createHash('sha256').update(process.env.ADMIN_PASSWORD || 'wavepass-change-me').digest('hex');

  constructor(
    private readonly prisma: PrismaService,
    private readonly paystack: PaystackService,
  ) {}

  private verifyPassword(password: string): boolean {
    const given = createHash('sha256').update(password).digest('hex');
    const a = Buffer.from(given, 'utf8');
    const b = Buffer.from(this.cashoutPasswordHash, 'utf8');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  /** Back-compat alias — some older call sites use `verifyAdminPassword`. */
  private verifyAdminPassword(password: string): boolean {
    return this.verifyPassword(password);
  }

  private async executeTransfer(cashout: any, bank: any) {
    if (this.paystack.isMock()) {
      return this.prisma.cashout.update({
        where: { id: cashout.id },
        data: {
          status: 'COMPLETED',
          providerTransferCode: 'mock_' + Date.now(),
          providerTransferRef: `MOCK-${cashout.id.slice(0, 8)}`,
          processedAt: new Date(),
          completedAt: new Date(),
        },
        include: { bankAccount: true },
      });
    }

    if (!bank.providerRecipientCode) {
      throw new BadRequestException(
        'Venue bank account has not been registered as a Paystack transfer recipient.',
      );
    }

    const transfer = await this.paystack.initiateTransfer({
      amountMinor: cashout.amountMinor,
      recipientCode: bank.providerRecipientCode!,
      reason: `WavePass cashout → ${bank.accountName} (${bank.accountNumber})`,
    });

    const processing = await this.prisma.cashout.update({
      where: { id: cashout.id },
      data: {
        status: 'PROCESSING',
        providerTransferCode: transfer.transfer_code,
        providerTransferRef: transfer.reference,
        processedAt: new Date(),
      },
      include: { bankAccount: true },
    });

    try {
      const verify = await this.paystack.verifyTransfer(transfer.transfer_code);
      const finalStatus =
        verify.data.status === 'success'
          ? 'COMPLETED'
          : verify.data.status === 'failed'
          ? 'FAILED'
          : processing.status;
      return this.prisma.cashout.update({
        where: { id: cashout.id },
        data: {
          status: finalStatus,
          ...(finalStatus === 'COMPLETED' ? { completedAt: new Date() } : {}),
          ...(finalStatus === 'FAILED' ? { failedAt: new Date(), failureReason: verify.data.status } : {}),
        },
        include: { bankAccount: true },
      });
    } catch (err: any) {
      this.logger.warn(`Could not finalise transfer ${transfer.transfer_code}: ${err.message}`);
      return processing;
    }
  }

  /** Accumulated, usable venue balance = fulfilled payments minus pending/paid cashouts. */
  async venueBalance(venueId: string) {
    const [fulfilled, cashouts] = await Promise.all([
      this.prisma.payment.aggregate({
        where: {
          status: 'FULFILLED',
          order: { venueId },
        },
        _sum: { amountMinor: true },
      }),
      this.prisma.cashout.findMany({
        where: { venueId, status: { in: ['PENDING', 'APPROVED', 'CONFIRMED', 'PROCESSING'] } },
        select: { amountMinor: true },
      }),
    ]);

    const earned = fulfilled._sum.amountMinor || 0;
    const locked = cashouts.reduce((acc, c) => acc + c.amountMinor, 0);

    return {
      venueId,
      earnedMinor: earned,
      lockedMinor: locked,
      availableMinor: Math.max(0, earned - locked),
      availableNGN: Math.round(Math.max(0, earned - locked) / 100),
    };
  }

  async registerBankAccount(dto: RegisterBankAccountDto) {
    const venue = await this.prisma.venue.findUnique({ where: { id: dto.venueId } });
    if (!venue) throw new NotFoundException(`Venue ${dto.venueId} not found`);

    let recipientCode: string | null = null;
    if (!this.paystack.isMock()) {
      const recipient = await this.paystack.createTransferRecipient({
        name: dto.accountName,
        accountNumber: dto.accountNumber,
        bankCode: dto.bankCode,
      });
      recipientCode = recipient.recipient_code;
    }

    const count = await this.prisma.bankAccount.count({ where: { venueId: dto.venueId } });
    return this.prisma.bankAccount.create({
      data: {
        venueId: dto.venueId,
        accountName: dto.accountName,
        accountNumber: dto.accountNumber,
        bankCode: dto.bankCode,
        bankName: dto.bankName,
        providerRecipientCode: recipientCode,
        isDefault: count === 0,
      },
    });
  }

  async listBankAccounts(venueId: string) {
    return this.prisma.bankAccount.findMany({
      where: { venueId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async requestCashout(dto: RequestCashoutDto) {
    if (!this.verifyPassword(dto.password)) {
      throw new UnauthorizedException('Invalid password — cashout not authorised');
    }

    const venue = await this.prisma.venue.findUnique({ where: { id: dto.venueId } });
    if (!venue) throw new NotFoundException(`Venue ${dto.venueId} not found`);

    const balance = await this.venueBalance(dto.venueId);
    if (dto.amountMinor > balance.availableMinor) {
      throw new BadRequestException(
        `Insufficient available balance (available ${balance.availableMinor} kobo)`,
      );
    }

    const bankAccount = await this.prisma.bankAccount.findFirst({
      where: { venueId: dto.venueId, isDefault: true },
    });
    if (!bankAccount) {
      throw new BadRequestException(
        'No bank account registered for this venue. Register one before requesting a cashout.',
      );
    }

    // Auto-cashout: create as CONFIRMED/PROCESSING and execute immediately —
    // the owner's password + sufficient balance is the only gate.
    const cashout = await this.prisma.cashout.create({
      data: {
        venueId: dto.venueId,
        bankAccountId: bankAccount.id,
        amountMinor: dto.amountMinor,
        status: 'CONFIRMED',
        confirmedAt: new Date(),
        reviewedAt: new Date(),
      },
      include: { bankAccount: true },
    });

    return this.executeTransfer(cashout, bankAccount);
  }

  /**
   * Owner/admin confirms a *pending* cashout with their password (back-compat).
   * New flow auto-executes on `requestCashout`, so this is only needed for
   * cashouts created before that change.
   */
  async confirmCashout(dto: ConfirmCashoutDto, adminPassword: string) {
    const cashout = await this.prisma.cashout.findUnique({
      where: { id: dto.cashoutId },
      include: { bankAccount: true, venue: true },
    });
    if (!cashout) throw new NotFoundException(`Cashout ${dto.cashoutId} not found`);
    if (!['PENDING', 'APPROVED'].includes(cashout.status)) {
      throw new BadRequestException(`Cashout is already ${cashout.status}`);
    }
    if (!this.verifyPassword(adminPassword)) {
      throw new UnauthorizedException('Invalid password — cashout not authorised');
    }

    const bank = cashout.bankAccount;
    const confirmed = await this.prisma.cashout.update({
      where: { id: cashout.id },
      data: {
        confirmedBy: dto.adminId || 'owner',
        reviewedAt: new Date(),
        confirmedAt: new Date(),
      },
      include: { bankAccount: true },
    });

    return this.executeTransfer(confirmed, bank);
  }

  async rejectCashout(cashoutId: string, adminPassword: string, reason?: string) {
    const cashout = await this.prisma.cashout.findUnique({ where: { id: cashoutId } });
    if (!cashout) throw new NotFoundException(`Cashout ${cashoutId} not found`);
    if (!['PENDING', 'APPROVED'].includes(cashout.status)) {
      throw new BadRequestException(`Cashout is already ${cashout.status}`);
    }
    if (!this.verifyPassword(adminPassword)) {
      throw new UnauthorizedException('Invalid password — cashout not rejected');
    }
    return this.prisma.cashout.update({
      where: { id: cashoutId },
      data: { status: 'REJECTED', rejectedAt: new Date(), rejectReason: reason },
    });
  }

  async listByVenue(venueId: string) {
    return this.prisma.cashout.findMany({
      where: { venueId },
      include: { bankAccount: true },
      orderBy: { createdAt: 'desc' },
    });
  }
}