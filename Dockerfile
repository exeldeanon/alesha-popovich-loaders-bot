FROM node:24-alpine
WORKDIR /usr/src/app
COPY package.json ./
COPY bot ./bot
RUN mkdir -p /usr/src/app/data && chown -R node:node /usr/src/app
USER node
ENV BOT_DB_PATH=/usr/src/app/data/bot.sqlite
CMD ["node","bot/index.mjs"]
