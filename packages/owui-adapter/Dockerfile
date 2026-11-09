# OpenAI-compatible adapter for Open WebUI → Instinct agent bridge.
# Stateless — no volume needed. ~256MB shared-cpu-1x.

FROM node:22-slim AS base
ENV NODE_ENV=production
WORKDIR /app

# Manifests first for layer caching.
FROM base AS deps
COPY package.json ./
RUN npm install --include=dev

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
# tsconfig extends ../../tsconfig.base.json which isn't in the build context;
# override with inline compiler options by creating a standalone tsconfig
RUN cat > tsconfig.docker.json <<'EOF'
{
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "target": "ES2022",
    "lib": ["ES2022"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist", "test"]
}
EOF
RUN npx tsc -p tsconfig.docker.json

FROM base AS runtime
COPY --from=build /app/dist ./dist
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./

ENV PORT=8080
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]