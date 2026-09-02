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
    return res.json();
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
}
