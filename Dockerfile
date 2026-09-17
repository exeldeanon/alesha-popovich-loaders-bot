FROM node:24-alpine
WORKDIR /usr/src/app
COPY package.json ./
COPY bot ./bot
RUN mkdir -p /app/data && chown -R node:node /usr/src/app /app/data
USER node
ENV BOT_DB_PATH=/app/data/bot.sqlite
CMD ["node","bot/index.mjs"]
