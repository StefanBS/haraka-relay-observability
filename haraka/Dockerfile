FROM node:22-alpine

WORKDIR /app
# express is required by Haraka's built-in HTTP server but is not one of its
# dependencies; prom-client backs the metrics plugin.
RUN npm install --no-audit --no-fund haraka@3.3.1 express@4 prom-client@15
ENV PATH="/app/node_modules/.bin:${PATH}"

# haraka-config only merges packaged defaults (connection.ini's message/max/uuid
# sections, log.ini's level) into a file that already exists in the target
# config dir -- with nothing there yet it silently omits them, and core
# Haraka crashes on connect (cfg.message is undefined) with the "delivered"
# log line filtered out (default loglevel is WARN, "delivered" logs at
# NOTICE). `haraka -i` seeds the packaged baseline; our config/ below then
# overlays the task's own smtp.ini/http.ini/me/queue_dir/plugins on top.
#
# Same gap bites outbound.bounce_message: `haraka -i` does not seed it, and a
# missing template is not an error -- config.get() just returns empty, so
# bounces still send but with no From:, no Subject: and an empty body. The
# machine-readable delivery-status part is built in code and looks fine, which
# makes it easy to miss. We ship our own copy in config/ below -- Haraka's
# packaged default minus its {extended_reason} line, which only populates on
# per-recipient rejections and otherwise renders as a bare "?" (core's
# substitution is `values[word] || '?'`) at the end of the sender's notice.
RUN haraka -i /app/haraka

COPY config /app/haraka/config
COPY plugins /app/haraka/plugins
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh && mkdir -p /data/queue

EXPOSE 2525 9090
ENTRYPOINT ["docker-entrypoint.sh"]
