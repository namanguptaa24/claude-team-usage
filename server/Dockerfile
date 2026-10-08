FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8787 DB_PATH=/data/usage.db
COPY package.json ./
COPY src ./src
COPY public ./public
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8787/api/health || exit 1
CMD ["node", "src/index.js"]
