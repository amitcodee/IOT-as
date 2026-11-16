FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

# The server has no runtime dependencies; only the app files are needed.
COPY server.mjs package.json ./
COPY lib ./lib
COPY public ./public

EXPOSE 3000
USER node
CMD ["node", "server.mjs"]
