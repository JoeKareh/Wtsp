# Caddy with the Cloudflare DNS plugin: needed for ONE wildcard certificate (*.yourdomain) covering every customer subdomain.
FROM caddy:2-builder AS build
RUN xcaddy build --with github.com/caddy-dns/cloudflare
FROM caddy:2
COPY --from=build /usr/bin/caddy /usr/bin/caddy
