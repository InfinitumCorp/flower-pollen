# Flower(TM) & POLLEN(TM) fleet backend. Node runs the TypeScript directly; there is no build step.
FROM node:24-slim
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    FP_DB_PATH=/data/flower-pollen.db \
    FP_SIGNING_KEY_PATH=/data/command-signing-key.pem
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
COPY proto ./proto
COPY THIRD_PARTY_NOTICES.md README.md ./
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.ts"]
