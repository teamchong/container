# The gateway is an I/O-bound proxy, so it runs fine inside apple/container's
# Linux VM. Only llama.cpp inference stays native on the host (for Metal) —
# this image never tries to run the model.
FROM node:22-alpine

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY bin ./bin

ENV GATEWAY_PORT=8787
# Inside the VM the gateway must reach the host's native llama-server. This is
# the host address as seen from the apple/container guest; override at run time
# with -e LOCAL_LLAMA_BASE=... if your host gateway IP differs.
ENV LOCAL_LLAMA_BASE=http://192.168.64.1:8080

EXPOSE 8787
CMD ["node", "src/server.mjs"]
