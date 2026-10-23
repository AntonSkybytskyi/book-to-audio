# syntax=docker/dockerfile:1.7
# nginx in front of web and core. Build from the repository root: docker build -f apps/edge/Dockerfile .

# Runs as a normal user and listens on 8080.
FROM nginxinc/nginx-unprivileged:1.28-alpine

# Where web and core answer (the compose service names), and the upload limit core enforces.
# NGINX_ENTRYPOINT_LOCAL_RESOLVERS makes the entrypoint read the DNS server from /etc/resolv.conf.
ENV WEB_UPSTREAM=web:3000 \
    CORE_UPSTREAM=core:3000 \
    MAX_UPLOAD_MB=200 \
    NGINX_ENTRYPOINT_LOCAL_RESOLVERS=1

USER root
RUN rm /etc/nginx/conf.d/default.conf
USER nginx
COPY apps/edge/edge.conf.template /etc/nginx/templates/
COPY --chmod=755 apps/edge/18-upload-limit.envsh /docker-entrypoint.d/
EXPOSE 8080
