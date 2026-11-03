FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY src ./src
COPY public ./public

EXPOSE 3000
# Le serveur parle à Docker via le socket monté : il tourne en root dans son conteneur.
CMD ["node", "src/server.js"]
