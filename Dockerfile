# BizControl: zero runtime dependencies, so the image is just Node + the source.
ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-alpine
WORKDIR /app
COPY package.json ./
COPY server ./server
COPY public ./public
COPY public-site ./public-site
COPY public-admin ./public-admin
COPY scripts ./scripts
ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0 DB_PATH=/data/bizcontrol.sqlite LOG_FORMAT=json
RUN mkdir -p /data && chown -R node:node /data /app
VOLUME /data
EXPOSE 3000
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
STOPSIGNAL SIGTERM
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
