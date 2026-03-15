FROM node:22-bullseye

# Install git and build tools
RUN apt-get update && apt-get install -y git python3 make g++ cmake linux-libc-dev

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
