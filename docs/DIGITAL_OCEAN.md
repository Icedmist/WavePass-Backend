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

## Droplet (VM, $6/mo, gives root for WireGuard tunnel mode)

```bash
# Create Droplet (1 vCPU/1GB) + Docker
doctl compute droplet create wavepass --image docker-20-04 --size s-1vcpu-1gb --region ams --ssh-keys <your-key-id>
ssh root@<droplet-ip>
git clone https://github.com/Icedmist/WavePass-Backend.git && cd WavePass-Backend
cp .env.example .env && nano .env  # fill DATABASE_URL, REDIS_URL, etc.
docker compose up -d --build
# Caddy/Nginx front: 80→3000, 443→3000
curl http://localhost:3000/api/v1/venues/default
```

Droplet is the **only** DO option that can host `wg0` for `connectionMode: tunnel` (needs `NET_ADMIN`). App Platform cannot.

## After deploy

Test: `curl https://your-app.ondigitalocean.app/api/v1/venues/by-subdomain/my-venue` → venue with `logoUrl` + `plans`.

See `docs/CLOUD_RUN.md` for env stripping (`grep -v '^PORT=' | sed -E 's/="(.*)"/=\1/' > /tmp/clean.env`).
