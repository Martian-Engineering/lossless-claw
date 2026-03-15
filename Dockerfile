FROM node:22-alpine

# Install git, python3, make, and build-base (g++) to build native extensions
RUN apk add --no-cache git python3 make build-base cmake

# Install openclaw globally
RUN npm install -g openclaw@latest

# Copy our patched plugin
WORKDIR /plugin
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build || true # Just in case

# Set up openclaw workspace
WORKDIR /root/.openclaw
RUN openclaw wizard init --non-interactive || true

# Install our local plugin into the docker openclaw instance
RUN openclaw plugin install /plugin

ENTRYPOINT ["openclaw", "gateway", "start", "--foreground"]
