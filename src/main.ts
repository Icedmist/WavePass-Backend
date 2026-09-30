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
  app.enableCors({
    origin: (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) => {
      // Always allow requests and reflect the origin (supports captive portals on local router domains,
      // e.g. nuru.net, 192.168.88.1, as well as *.nexawavepass.com).
      // Never pass an Error to cb() as that causes Fastify to return HTTP 500 on OPTIONS preflights.
      cb(null, true);
    },
    credentials: true,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    allowedHeaders: 'Content-Type, Authorization, x-paystack-signature, Accept, Origin, X-Requested-With',
  });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

  const port = process.env.PORT ? Number(process.env.PORT) : 3000;
  await app.listen(port, '0.0.0.0');
  // eslint-disable-next-line no-console
  console.log(`WavePass API listening on :${port}`);
}
bootstrap();
