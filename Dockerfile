# OWCS Scenario Tracker: zero-dependency Node server + static component.
#   docker build -t owcs-scenarios .
#   docker run -p 3000:3000 -e OWTV_API_KEY=... owcs-scenarios
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production PORT=3000
COPY package.json server.mjs ./
COPY public ./public

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "server.mjs"]
