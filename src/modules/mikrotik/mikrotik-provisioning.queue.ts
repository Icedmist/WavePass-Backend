import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

@Injectable()
export class MikrotikProvisioningQueue {
  constructor(@InjectQueue('mikrotik-provisioning') private readonly queue: Queue) {}

  enqueue(data: { orderId?: string; voucherId?: string }) {
    const jobId = data.orderId ? `order:${data.orderId}` : `voucher:${data.voucherId}`;
    return this.queue.add('provision', data, {
      jobId,
      attempts: 8,
      backoff: { type: 'exponential', delay: 3000 },
      removeOnComplete: true,
    });
  }
}
