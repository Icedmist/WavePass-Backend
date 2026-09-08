# Build Stage
FROM node:22-alpine AS builder

WORKDIR /app

RUN apk add --no-cache openssl && npm install -g pnpm

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml* ./
COPY prisma ./prisma/

RUN pnpm install --frozen-lockfile
RUN npx prisma generate

COPY tsconfig*.json nest-cli.json ./
COPY src ./src/

RUN pnpm build

# Production Runtime Stage
FROM node:22-alpine AS runner

WORKDIR /app

RUN apk add --no-cache openssl

ENV NODE_ENV=production
ENV PORT=3000

COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma

EXPOSE 3000

CMD ["node", "dist/src/main.js"]
