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
  // Admin platform password — elevated ops (reconcile, reject, cross-venue)
  private readonly adminPasswordHash =
    process.env.ADMIN_PASSWORD_HASH ||
    createHash('sha256').update(process.env.ADMIN_PASSWORD || 'wavepass-change-me').digest('hex');
  // Venue-owner cashout password — auto-cashout without admin gate
  private readonly ownerPasswordHash =
    process.env.OWNER_CASHOUT_PASSWORD_HASH ||
    process.env.ADMIN_PASSWORD_HASH ||
    createHash('sha256').update(
      process.env.OWNER_CASHOUT_PASSWORD || process.env.ADMIN_PASSWORD || 'wavepass-change-me',
    ).digest('hex');

  constructor(
    private readonly prisma: PrismaService,
    private readonly paystack: PaystackService,
  ) {}

  /** Owner password — gates auto-cashout (fast, per-venue). Falls back to admin hash. */
  private verifyOwnerPassword(password: string): boolean {
    const given = createHash('sha256').update(password).digest('hex');
    const a = Buffer.from(given, 'utf8');
    // accept either owner hash or admin hash (admin can also cash out)
    for (const hash of [this.ownerPasswordHash, this.adminPasswordHash]) {
      const b = Buffer.from(hash, 'utf8');
      if (a.length === b.length && timingSafeEqual(a, b)) return true;
    }
    return false;
  }

  /** Admin password — elevated ops only. */
  private verifyAdminPassword(password: string): boolean {
    const given = createHash('sha256').update(password).digest('hex');
    const a = Buffer.from(given, 'utf8');
    const b = Buffer.from(this.adminPasswordHash, 'utf8');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  /** Back-compat alias */
  private verifyPassword(password: string): boolean {
    return this.verifyOwnerPassword(password);
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

    // Self-heal: a recipient that failed at registration time is retried here
    // instead of failing the owner's cashout.
    try {
      bank = await this.ensureRecipient(bank);
    } catch (err: any) {
      throw new BadRequestException(
        `Venue bank account is not registered as a Paystack transfer recipient (${err.message}).`,
      );
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

  /** Accumulated, usable venue balance = fulfilled payments minus pending/completed cashouts.
   *  Accepts a transaction client so balance checks can run atomically with
   *  cashout creation under Serializable isolation (no double-spend race). */
  async venueBalance(venueId: string, db?: any) {
    const prisma = db || this.prisma;
    const [fulfilled, pendingCashouts, completedCashouts] = await Promise.all([
      prisma.payment.aggregate({
        where: {
          status: 'FULFILLED',
          order: { venueId },
        },
        _sum: { amountMinor: true },
      }),
      prisma.cashout.findMany({
        where: { venueId, status: { in: ['PENDING', 'APPROVED', 'CONFIRMED', 'PROCESSING'] } },
        select: { amountMinor: true },
      }),
      prisma.cashout.findMany({
        where: { venueId, status: 'COMPLETED' },
        select: { amountMinor: true },
      }),
    ]);

    const earned = fulfilled._sum.amountMinor || 0;
    const locked = pendingCashouts.reduce((acc: number, c: { amountMinor: number }) => acc + c.amountMinor, 0);
    const cashedOut = completedCashouts.reduce((acc: number, c: { amountMinor: number }) => acc + c.amountMinor, 0);
    const availableMinor = Math.max(0, earned - locked - cashedOut);

    return {
      venueId,
      earnedMinor: earned,
      lockedMinor: locked,
      cashedOutMinor: cashedOut,
      availableMinor,
      availableNGN: Math.round(availableMinor / 100),
      pendingNGN: Math.round(locked / 100),
      totalEarnedNGN: Math.round(earned / 100),
      cashedOutNGN: Math.round(cashedOut / 100),
    };
  }

  async registerBankAccount(dto: RegisterBankAccountDto) {
    const venue = await this.prisma.venue.findUnique({ where: { id: dto.venueId } });
    if (!venue) throw new NotFoundException(`Venue ${dto.venueId} not found`);

    let recipientCode: string | null = null;
    let recipientPending = false;
    if (!this.paystack.isMock()) {
      try {
        const recipient = await this.paystack.createTransferRecipient({
          name: dto.accountName,
          accountNumber: dto.accountNumber,
          bankCode: dto.bankCode,
        });
        recipientCode = recipient.recipient_code;
      } catch (err: any) {
        // Don't force the owner to retype the whole form on a Paystack blip —
        // save the account and self-heal the recipient at cashout time.
        this.logger.warn(`Transfer recipient creation failed, will retry at cashout: ${err.message}`);
        recipientPending = true;
      }
    }

    const count = await this.prisma.bankAccount.count({ where: { venueId: dto.venueId } });
    const account = await this.prisma.bankAccount.create({
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
    return { ...account, recipientPending };
  }

  /** Creates the Paystack transfer recipient on demand if a previous attempt failed. */
  private async ensureRecipient(bank: any) {
    if (bank.providerRecipientCode || this.paystack.isMock()) return bank;
    const recipient = await this.paystack.createTransferRecipient({
      name: bank.accountName,
      accountNumber: bank.accountNumber,
      bankCode: bank.bankCode,
    });
    return this.prisma.bankAccount.update({
      where: { id: bank.id },
      data: { providerRecipientCode: recipient.recipient_code },
    });
  }

  async listBankAccounts(venueId: string) {
    return this.prisma.bankAccount.findMany({
      where: { venueId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async requestCashout(dto: RequestCashoutDto) {
    if (!this.verifyOwnerPassword(dto.password)) {
      throw new UnauthorizedException('Invalid owner password — cashout not authorised');
    }

    const venue = await this.prisma.venue.findUnique({ where: { id: dto.venueId } });
    if (!venue) throw new NotFoundException(`Venue ${dto.venueId} not found`);

    // Idempotent replay: same client key returns the original cashout.
    if (dto.clientReference) {
      const prior = await this.prisma.cashout.findUnique({
        where: { clientReference: dto.clientReference },
        include: { bankAccount: true },
      });
      if (prior) return prior;
    }

    const bankAccount = await this.prisma.bankAccount.findFirst({
      where: { venueId: dto.venueId, isDefault: true },
    });
    if (!bankAccount) {
      throw new BadRequestException(
        'No bank account registered for this venue. Register one before requesting a cashout.',
      );
    }

    // Balance check + creation run atomically under Serializable isolation so
    // concurrent double-taps cannot overdraw the venue (one retry on conflict).
    let cashout: any = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        cashout = await this.prisma.$transaction(async (tx) => {
          const balance = await this.venueBalance(dto.venueId, tx);
          if (dto.amountMinor > balance.availableMinor) {
            throw new BadRequestException(
              `Insufficient available balance (available ${balance.availableMinor} kobo)`,
            );
          }
          // Auto-cashout: create as CONFIRMED and execute immediately —
          // the owner's password + sufficient balance is the only gate.
          return tx.cashout.create({
            data: {
              venueId: dto.venueId,
              bankAccountId: bankAccount.id,
              amountMinor: dto.amountMinor,
              status: 'CONFIRMED',
              clientReference: dto.clientReference,
              confirmedAt: new Date(),
              reviewedAt: new Date(),
            },
            include: { bankAccount: true },
          });
        }, { isolationLevel: 'Serializable' } as any);
        break;
      } catch (err: any) {
        if (err.code === 'P2034' && attempt === 0) continue; // serialization conflict — retry once
        if (err.code === 'P2002' && dto.clientReference) {
          // Lost the idempotency race — return the winner's row.
          const winner = await this.prisma.cashout.findUnique({
            where: { clientReference: dto.clientReference },
            include: { bankAccount: true },
          });
          if (winner) return winner;
        }
        throw err;
      }
    }

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

  /**
   * Finalizes cashouts stuck in PROCESSING (verify call failed at payout
   * time). Called from admin reconcile and safe to run on a schedule.
   */
  async reconcileProcessing(venueId?: string) {
    const stuck = await this.prisma.cashout.findMany({
      where: { status: 'PROCESSING', ...(venueId ? { venueId } : {}) },
      include: { bankAccount: true },
    });
    const finalized: any[] = [];
    let skipped = 0;
    for (const c of stuck) {
      if (!c.providerTransferCode || c.providerTransferCode.startsWith('mock_')) {
        continue; // mock rows complete inline; nothing to verify
      }
      if (this.paystack.isMock()) {
        skipped++;
        continue;
      }
      try {
        const verify = await this.paystack.verifyTransfer(c.providerTransferCode);
        const finalStatus =
          verify.data.status === 'success'
            ? 'COMPLETED'
            : verify.data.status === 'failed'
            ? 'FAILED'
            : c.status;
        if (finalStatus === c.status) {
          skipped++;
          continue;
        }
        finalized.push(
          await this.prisma.cashout.update({
            where: { id: c.id },
            data: {
              status: finalStatus,
              ...(finalStatus === 'COMPLETED' ? { completedAt: new Date() } : {}),
              ...(finalStatus === 'FAILED' ? { failedAt: new Date(), failureReason: verify.data.status } : {}),
            },
          }),
        );
      } catch (err: any) {
        this.logger.warn(`Reconcile skipped ${c.id}: ${err.message}`);
        skipped++;
      }
    }
    return { checked: stuck.length, finalized: finalized.length, skipped };
  }
}