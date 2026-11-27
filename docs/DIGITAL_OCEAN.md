# Deploy WavePass Backend to DigitalOcean

Two managed options — same `Dockerfile:1`. Free $200 credit for new accounts covers MVP.

## App Platform (managed, like Railway)

```bash
# 1) Push image to DOCR
doctl auth init
doctl registry create wavepass --region ams
doctl registry login
docker build -t registry.digitalocean.com/wavepass/api:latest .
docker push registry.digitalocean.com/wavepass/api:latest

# 2) Create App from GitHub (Console → Apps → Create → Icedmist/WavePass-Backend, branch main, Dockerfile)
# Or via spec:
doctl apps create --spec .do/app.yaml
```

`.do/app.yaml` (region `ams`, `instance_size_slug: basic-xs`, `https`):

```yaml
name: wavepass-api
region: ams
services:
- name: api
  github: { repo: Icedmist/WavePass-Backend, branch: main }
  dockerfile_path: Dockerfile
  http_port: 3000
  instance_size_slug: basic-xs
  envs:
  - { key: DATABASE_URL, value: ${DATABASE_URL}, type: SECRET }
  - { key: REDIS_URL, value: ${REDIS_URL}, type: SECRET }
  - { key: FRONTEND_URL, value: https://your-venue.nexawavepass.com }
  - { key: JWT_SECRET, value: ${JWT_SECRET}, type: SECRET }
```

App URL: `https://wavepass-api-xxxxx.ondigitalocean.app` — add custom domain `api.your-venue.nexawavepass.com`.

## Droplet (Production VM — `165.227.161.167`, Ubuntu 24.04 LTS)

```bash
# 1) SSH into Droplet
ssh root@165.227.161.167

# 2) Mandatory: Configure 2 GB Swap (Prevents Out-Of-Memory freezes)
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# 3) Clone repository and configure environment
git clone https://github.com/Icedmist/WavePass-Backend.git /root/WavePass-Backend
cd /root/WavePass-Backend
cp .env.example .env && nano .env

# In .env, set local Redis URL and Supabase/Paystack production credentials:
# REDIS_URL=redis://redis:6379
# FRONTEND_URL=https://nexawavepass.com

# 4) Launch stack with local Redis (capped at 128MB RAM) and run Prisma migrations
docker compose up -d --build
docker compose run --rm --no-deps api npx prisma migrate deploy

# 5) Configure Caddy HTTPS Reverse Proxy (/etc/caddy/Caddyfile)
# api.nexawavepass.com {
#     reverse_proxy 127.0.0.1:4000
# }
systemctl reload caddy

# 6) Verify Health
curl http://127.0.0.1:4000/api/v1/health
curl http://127.0.0.1:4000/api/v1/health/ready
curl https://api.nexawavepass.com/api/v1/health
```

### Automated CI/CD (`.github/workflows/build.yml`)
- Builds and pushes the container image to GitHub Container Registry (`ghcr.io/icedmist/wavepass-backend:latest`) using `GITHUB_TOKEN`.
- Connects via SSH (`DROPLET_IP`, `DROPLET_SSH_KEY`) and runs in strict order:
  1. `git fetch origin main && git reset --hard origin/main`
  2. `docker compose pull api || docker compose build api`
  3. `docker compose up -d redis postgres`
  4. `docker compose run --rm --no-deps api npx prisma migrate deploy`
  5. `docker compose up -d --no-deps api`
  6. Health check verification against `/api/v1/health` and `/api/v1/health/ready`.

Droplet is the **only** DO option that can host `wg0` for `connectionMode: tunnel` (needs `NET_ADMIN`). App Platform cannot.

## After deploy

Test: `curl https://your-app.ondigitalocean.app/api/v1/venues/by-subdomain/my-venue` → venue with `logoUrl` + `plans`.

See `docs/CLOUD_RUN.md` for env stripping (`grep -v '^PORT=' | sed -E 's/="(.*)"/=\1/' > /tmp/clean.env`).
