FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN apk add --no-cache git && npm install --omit=dev --no-audit --no-fund && npm cache clean --force && apk del git
COPY server.js ./
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000
CMD ["node", "server.js"]
