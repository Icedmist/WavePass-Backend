# Deploy WavePass Backend to Cloud Run

`wavepass-backend` is a NestJS Fastify API (`Dockerfile:1`, Node 22) that serves `api/v1` + BullMQ queues. This doc covers **Cloud Run** via `gcloud` — billing required (free tier 2M req).

## 0) Prereqs

```bash
gcloud auth login
gcloud config set project YOUR_PROJECT  # e.g. nexa-storeos / techwithnexa / wavepass
gcloud services enable run.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com
gcloud artifacts repositories create wavepass --repository-format=docker --location=us-central1
gcloud auth configure-docker us-central1-docker.pkg.dev
```

If new project: link billing first (`Console → Billing → My Billing Account` or `gcloud beta billing projects link PROJECT --billing-account=0131AD-8F9E26-21DB30`).

## 1) Build & Push

```bash
# from /wavepass-backend
gcloud builds submit --tag us-central1-docker.pkg.dev/PROJECT/wavepass/api:latest
# locally: docker build -t us-central1-docker.pkg.dev/PROJECT/wavepass/api:latest . && docker push ...
```

`Dockerfile` is multi-stage: `builder` (`pnpm install`, `prisma generate`, `pnpm build` → `dist/main.js`) → `runner` (`node:22-alpine + openssl`, `NODE_ENV=production`, `PORT=3000`, `CMD ["node","dist/main.js"]`). Requires `openssl` at runtime for Prisma.

## 2) Env

Do **not** put `PORT` in env — Cloud Run injects it (use `--port 3000`). Strip `""` quotes:

```bash
grep -E '^[A-Z_]+=' .env | grep -v '^PORT=' | sed -E 's/^([A-Z_]+)="(.*)"$/\1=\2/' > /tmp/clean.env
# contains: DATABASE_URL (pooler :6543?pgbouncer=true), DIRECT_DATABASE_URL (:5432), REDIS_URL (Upstash rediss://), PAYSTACK_*, SUPABASE_*, JWT_SECRET, ENCRYPTION_KEY, ADMIN_PASSWORD_HASH etc.
```

For secrets prefer Secret Manager:

```bash
echo -n "postgresql://..." | gcloud secrets create DATABASE_URL --data-file=-
gcloud secrets create REDIS_URL --data-file=-   # etc.
```

## 3) Deploy

With `--env-vars-file`:

```bash
gcloud run deploy wavepass-api \
  --image us-central1-docker.pkg.dev/PROJECT/wavepass/api:latest \
  --region us-central1 --platform managed --allow-unauthenticated \
  --port 3000 --memory 512Mi --concurrency 80 \
  --env-vars-file /tmp/clean.env
```

With secrets:

```bash
gcloud run deploy wavepass-api \
  --image us-central1-docker.pkg.dev/PROJECT/wavepass/api:latest \
  --region us-central1 --allow-unauthenticated --port 3000 \
  --set-secrets DATABASE_URL=DATABASE_URL:latest,REDIS_URL=REDIS_URL:latest \
  --set-env-vars FRONTEND_URL=https://wavepass-web.vercel.app,NODE_ENV=production
```

Check: `gcloud run services describe wavepass-api --region us-central1` → `https://wavepass-api-...run.app`
Test: `curl https://...run.app/api/v1/venues/default` and `/api/v1/portal/landing?mac=AA:BB:CC:DD:EE:FF`

## 4) Troubleshooting

- `PORT reserved` → remove `PORT=` from env file (`grep -v '^PORT='`).
- `Cannot find module '/app/dist/main.js'` → ensure `Dockerfile` `RUN pnpm build` succeeded and `COPY --from=builder /app/dist` is present; runner needs `apk add --no-cache openssl`.
- `STARTUP TCP probe failed on port 3000` → app must `await app.listen(process.env.PORT||3000,'0.0.0.0')` (`src/main.ts:33`) — already does. Extend timeout: `--timeout 300`.
- `Python-dotenv could not parse` → strip `""` as above; no comments in env file.

## 5) Updates

Each push to `main` can auto-deploy via Cloud Build trigger (GitHub → `us-central1-docker.../api:latest` → `gcloud run deploy --image ...`).

See also `README.md: Deploy` and `.env.example`.
