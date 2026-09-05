# Dockerfile สำหรับ ChatAdminWeb (Next.js 16)
# Build: docker build -t chatadmin-web .
# Run:   docker run -p 3000:3000 --env-file .env.web chatadmin-web
#
# ภาพเดียวใช้ได้ 2 อย่าง:
#   - default CMD → Next.js web server (port 3000)
#   - override CMD → npx tsx scripts/bot-worker.ts (bot-worker pipeline)

# ── Stage 1: deps ──
FROM node:20-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev=false

# ── Stage 2: build ──
FROM node:20-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# build Next.js (standalone output)
# `next build` collects page data for every API route, which imports config.ts and
# evaluates its requiredStrict() secret checks eagerly (module load time) — these
# placeholders only satisfy that check at build time. They do NOT leak to the runner
# stage below (fresh FROM, no ENV inherited) — real secrets still come from env_file
# (.env.web) at container runtime, and requiredStrict() still enforces them there.
ENV ADMIN_JWT_SECRET=build-time-placeholder \
    CHATBOT_INTERNAL_SECRET=build-time-placeholder
RUN npm run build

# ── Stage 3: runner (production) ──
FROM node:20-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# ── Next.js standalone (web server) ──
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

# ── bot-worker needs: source + tsconfig + tsx ──
# copy source สำหรับ tsx รัน bot-worker.ts (imports from ../src/backend/...)
COPY --from=builder /app/src ./src
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/tsconfig.json ./tsconfig.json
COPY --from=builder /app/package.json ./package.json
# copy node_modules ที่มี tsx + typescript (จาก deps stage — มี devDependencies)
COPY --from=deps /app/node_modules ./node_modules

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=15s \
    CMD curl -fs http://localhost:3000/api/auth/me || exit 1

# default: รัน Next.js web server
# bot-worker override: command: ["npx", "tsx", "scripts/bot-worker.ts"]
CMD ["node", "server.js"]
