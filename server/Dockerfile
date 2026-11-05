FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY src ./src
COPY public ./public

EXPOSE 3000
# The server talks to Docker through the mounted socket, so it runs as root in its container.
CMD ["node", "src/server.js"]
