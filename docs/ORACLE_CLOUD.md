# Deploy WavePass Backend to Oracle Cloud (OCI)

Run the same `Dockerfile:1` (`node:22-alpine`, `pnpm build → dist/main.js`) on OCI Container Instances or OKE. Billing via OCI free tier + paygo.

## OCI Container Instances (simplest, no K8s)

```bash
# 1) Build locally and push to OCIR (Oracle Container Registry)
# Login: Username = tenancy/username, Token = Auth Token from OCI Console → Identity → Users → Auth Tokens
docker login lhr.ocir.io -u '<tenancy-namespace>/<username>'
docker build -t lhr.ocir.io/<tenancy>/wavepass-api:latest .
docker push lhr.ocir.io/<tenancy>/wavepass-api:latest

# 2) Create Container Instance (via Console or CLI)
oci container-instances container-instance create \
  --compartment-id ocid1.compartment.oc1... \
  --availability-domain <AD-1> \
  --shape CI.Standard.E4.Flex --shape-config ocpus=1,memoryInGBs=2 \
  --vnics '[{"subnetId":"ocid1.subnet...","isPublicIpAssigned":true}]' \
  --containers '[{"imageUrl":"lhr.ocir.io/<tenancy>/wavepass-api:latest","displayName":"wavepass-api","environmentVariables":{"DATABASE_URL":"postgresql://...","REDIS_URL":"rediss://...","FRONTEND_URL":"https://your-venue.nexawavepass.com","JWT_SECRET":"...","ADMIN_PASSWORD_HASH":"dae30fd40..."}}]' \
  --display-name wavepass-api
```

Open port 3000 in the VCN security list (Ingress 0.0.0.0/0:3000). Health check: `curl http://<public-ip>:3000/api/v1/venues/default`.

## OKE (Kubernetes)

```bash
kubectl create secret generic wavepass-env --from-env-file=/tmp/clean.env
kubectl apply -f k8s/deployment.yaml  # image: lhr.ocir.io/<tenancy>/wavepass-api:latest, port 3000, envFrom secret
kubectl apply -f k8s/service.yaml     # LoadBalancer
```

See `k8s/` examples or use `docker-compose.yml` on a single OCI VM (`VM.Standard.E4.Flex` free tier) with `docker compose up -d`.

## Env

Same `/tmp/clean.env` as Cloud Run (strip `PORT` + `""`). Required: `DATABASE_URL`, `DIRECT_DATABASE_URL`, `REDIS_URL`, `SUPABASE_URL`, `PAYSTACK_SECRET_KEY`, `FRONTEND_URL` (your subdomain e.g. `https://my-venue.nexawavepass.com`), `JWT_SECRET`, `ADMIN_PASSWORD_HASH`.
