FROM node:20-bookworm-slim AS base

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ghostscript \
    tesseract-ocr \
    poppler-utils \
    libreoffice \
    antiword \
    unrtf \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci

COPY src ./src
COPY public ./public
COPY migrations ./migrations
RUN npm run build

FROM node:20-bookworm-slim AS runtime
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    git \
    ghostscript \
    tesseract-ocr \
    poppler-utils \
    libreoffice \
    antiword \
    unrtf \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production
COPY --from=base /app/package.json ./package.json
COPY --from=base /app/node_modules ./node_modules
COPY --from=base /app/dist ./dist
COPY --from=base /app/public ./public
COPY --from=base /app/migrations ./migrations
RUN mkdir -p /app/data/uploads /app/import-dir
EXPOSE 3311
CMD ["node", "dist/index.js"]
