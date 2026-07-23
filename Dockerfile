# ---- Builder ----
FROM node:24-alpine AS builder

WORKDIR /app

# Reason: the committed lockfile is generated on macOS/arm64 and omits the nested
# @emnapi dependencies of the wasm32-wasi binding, which npm 11 on Linux expects.
# `npm ci` therefore rejects it, so dependencies are resolved at install time.
# This must stay in step with .github/workflows/pr-validation.yml.
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm install --no-audit --no-fund

COPY . ./
RUN npm run build

# ---- Release ----
FROM node:24-alpine AS release

WORKDIR /app

COPY --from=builder /app/package.json ./
COPY --from=builder /app/package-lock.json ./
COPY --from=builder /app/build ./build

ENV NODE_ENV=production

RUN --mount=type=cache,target=/root/.npm npm install --omit=dev --no-audit --no-fund

EXPOSE 3000
ENTRYPOINT ["node", "build/index.js"]
