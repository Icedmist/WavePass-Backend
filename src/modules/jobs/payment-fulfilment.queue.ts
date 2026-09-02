import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

@Injectable()
export class PaymentFulfilmentQueue {
  constructor(@InjectQueue('payment-fulfilment') private readonly queue: Queue) {}

  enqueue(data: { reference: string }) {
    // jobId = reference makes re-enqueueing the same payment a no-op at the queue level too.
    return this.queue.add('verify-and-fulfil', data, {
      jobId: data.reference,
      attempts: 5,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: true,
    });
  }
}
