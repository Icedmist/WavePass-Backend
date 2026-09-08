import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ trustProxy: true }),
    { bodyParser: false },
  );

  // Paystack signature verification needs the exact raw request body.
  // Capture it before Fastify's JSON parser runs, and stash it on the
  // request so PaystackWebhookController can HMAC it unmodified.
  const fastify = app.getHttpAdapter().getInstance();
  fastify.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (req: any, body: Buffer, done: (err: Error | null, body?: unknown) => void) => {
      req.rawBody = body;
      try {
        done(null, body.length ? JSON.parse(body.toString('utf8')) : {});
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  app.setGlobalPrefix('api/v1');
  const rawAllowList = (process.env.FRONTEND_URL || 'https://nexawavepass.com').split(',').map((s) => s.trim()).filter(Boolean);
  const allowedHosts = rawAllowList.map((u) => {
    try {
      return new URL(u).host.toLowerCase();
    } catch {
      return u.toLowerCase().replace(/^https?:\/\//, '').split('/')[0];
    }
  });
  app.enableCors({
    origin: (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) => {
      if (!origin) return cb(null, true);
      try {
        const host = new URL(origin).host.toLowerCase();
        const isLocal = host.startsWith('localhost') || host.startsWith('127.0.0.1');
        const isAllowed = allowedHosts.some((h) => {
          const clean = h.toLowerCase();
          if (clean.startsWith('*.')) return host.endsWith(clean.slice(1)) || host === clean.slice(2);
          return host === clean || host.endsWith('.' + clean);
        });
        if (isLocal || isAllowed) return cb(null, true);
        return cb(new Error('Not allowed by CORS'), false);
      } catch {
        return cb(null, true);
      }
    },
    credentials: true,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    allowedHeaders: 'Content-Type, Authorization, x-paystack-signature',
  });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  const port = process.env.PORT ? Number(process.env.PORT) : 3000;
  await app.listen(port, '0.0.0.0');
  // eslint-disable-next-line no-console
  console.log(`WavePass API listening on :${port}`);
}
bootstrap();
