# Built on the Umbrel itself: umbrelOS starts apps with `docker compose up --build`.
# DeepSeek Harness is installed here, at build time, from the official npm release.
FROM node:24.22.2-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c

WORKDIR /opt/dsh

# package.json pins the dsh version and allows the install scripts that build or
# fetch its native pieces (terminal PTY, FFI binding, subprocess spawn helper);
# recent npm skips dependency install scripts unless package.json allows them.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund \
 && npm cache clean --force

COPY launcher.mjs ./

USER 1000:1000
CMD ["node", "/opt/dsh/launcher.mjs"]
