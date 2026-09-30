# Retain the incident binary; Opi records/resolves its digest before rollout.
FROM ghcr.io/block/buzz:sha-82f7ed1
USER root
RUN apt-get update && apt-get install -y --no-install-recommends python3
COPY --chmod=0444 startup.py /usr/local/lib/buzz-startup.py
USER buzz:buzz
ENTRYPOINT ["/usr/bin/python3", "-B", "/usr/local/lib/buzz-startup.py", "/usr/local/bin/buzz-relay"]
