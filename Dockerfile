FROM node:24-alpine
WORKDIR /usr/src/app
COPY package.json ./
COPY bot ./bot
RUN mkdir -p /app/data /usr/src/app/data
ENV BOT_DB_PATH=/app/data/bot.sqlite
CMD ["node","bot/index.mjs"]
