import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';

interface InitializeParams {
  amountMinor: number;
  email: string;
  reference: string;
  metadata: Record<string, unknown>;
  callbackUrl?: string;
}

interface PaystackVerifyResponse {
  status: boolean;
  data: {
    status: 'success' | 'failed' | 'abandoned' | 'reversed' | 'pending';
    reference: string;
    amount: number; // minor units
    currency: string;
    id: number;
    channel: string;
    paid_at: string | null;
  };
}

@Injectable()
export class PaystackService {
  private readonly baseUrl = 'https://api.paystack.co';
  private readonly secretKey = process.env.PAYSTACK_SECRET_KEY as string;

  async initializeTransaction(params: InitializeParams) {
    const res = await fetch(`${this.baseUrl}/transaction/initialize`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: params.email,
        amount: params.amountMinor, // kobo
        reference: params.reference,
        metadata: params.metadata,
        callback_url: params.callbackUrl,
      }),
    });

    if (!res.ok) {
      throw new InternalServerErrorException('Paystack initialize failed');
    }
    return res.json();
  }

  /** Server-to-server verification — never trust the client-supplied status. */
  async verifyTransaction(reference: string): Promise<PaystackVerifyResponse> {
    const res = await fetch(
      `${this.baseUrl}/transaction/verify/${encodeURIComponent(reference)}`,
      { headers: { Authorization: `Bearer ${this.secretKey}` } },
    );
    if (!res.ok) {
      throw new InternalServerErrorException('Paystack verify failed');
    }
    return (await res.json()) as PaystackVerifyResponse;
  }

  /** HMAC SHA512 of the *raw* request body, compared with x-paystack-signature. */
  verifyWebhookSignature(rawBody: Buffer, signatureHeader: string | undefined): boolean {
    if (!signatureHeader) return false;
    const expected = createHmac('sha512', process.env.PAYSTACK_SECRET_KEY as string)
      .update(rawBody)
      .digest('hex');
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(signatureHeader, 'utf8');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  /** Whether the platform is running against a real Paystack key or the local mock. */
  isMock(): boolean {
    const secret = process.env.PAYSTACK_SECRET_KEY || '';
    return !secret || secret.includes('xxx') || secret.includes('test');
  }

  private async post<T = any>(path: string, body: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new InternalServerErrorException(
        `Paystack ${path} failed (${res.status}): ${await res.text()}`,
      );
    }
    return res.json() as Promise<T>;
  }

  private async get<T = any>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      headers: { Authorization: `Bearer ${this.secretKey}` },
    });
    if (!res.ok) {
      throw new InternalServerErrorException(
        `Paystack ${path} failed (${res.status}): ${await res.text()}`,
      );
    }
    return res.json() as Promise<T>;
  }

  /**
   * Dedicated Virtual Account (DVA) — the platform owns ONE Paystack key and
   * creates a private payment account for each venue. Payments into a venue's
   * DVA settle straight into the platform settlement account.
   * https://paystack.com/docs/payments/dedicated-virtual-account
   */
  async createCustomer(email: string, extra: { first_name?: string; last_name?: string }) {
    const data = await this.post<{ status: boolean; data: { customer_code: string; email: string } }>(
      '/customer',
      { email, ...extra },
    );
    return data.data;
  }

  async createDedicatedAccount(params: {
    customer: string;
    preferredBank?: string;
    metadata?: Record<string, unknown>;
  }) {
    const data = await this.post<{
      status: boolean;
      data: {
        id: number;
        account_number: string;
        account_name: string;
        bank: { name: string };
        split_code?: string;
      };
    }>('/dedicated_account', {
      customer: params.customer,
      preferred_bank: params.preferredBank || 'wema-bank',
      metadata: params.metadata || {},
    });
    return data.data;
  }

  /** Register the venue owner's NUBAN bank as the cashout transfer recipient (the safe payout target). */
  async createTransferRecipient(params: {
    name: string;
    accountNumber: string;
    bankCode: string;
    currency?: string;
  }) {
    const data = await this.post<{
      status: boolean;
      data: { recipient_code: string; currency: string; active: boolean };
    }>('/transferrecipient', {
      type: 'nuban',
      name: params.name,
      account_number: params.accountNumber,
      bank_code: params.bankCode,
      currency: params.currency || 'NGN',
    });
    return data.data;
  }

  /**
   * Initiate a payout from the platform balance to the venue owner's bank.
   * Returns the transfer code; the transfer is then confirmed/finalised and the
   * status polled via verifyTransfer.
   */
  async initiateTransfer(params: {
    amountMinor: number;
    recipientCode: string;
    reason?: string;
  }) {
    const data = await this.post<{
      status: boolean;
      data: { transfer_code: string; reference: string; amount: number; currency: string; status: string };
    }>('/transfer', {
      source: 'balance',
      amount: params.amountMinor,
      recipient: params.recipientCode,
      reason: params.reason || 'WavePass venue cashout',
    });
    return data.data;
  }

  async verifyTransfer(transferCode: string) {
    return this.get<{
      status: boolean;
      data: { status: string; transfer_code: string; amount: number; recipient: { name: string } };
    }>(`/transfer/verify/${encodeURIComponent(transferCode)}`);
  }

  /** Platform settlement balance available for cashouts (kobo). */
  async checkBalance() {
    const data = await this.get<{ status: boolean; data: { currency: string; balance: number }[] }>(
      '/balance',
    );
    return data.data.find((b) => b.currency === 'NGN') || data.data[0];
  }
}
