FROM node:20-alpine

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

COPY src ./src
COPY migrations ./migrations

EXPOSE 2358
CMD ["node", "src/api/server.js"]
