FROM node:22-bookworm

# Install git and build tools. Bookworm has newer cmake (3.25+)
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

# Install our local plugin into the docker openclaw instance
RUN openclaw plugins install /plugin

# Run openclaw gateway in the foreground, creating a dev config
ENTRYPOINT ["openclaw", "gateway", "run", "--dev", "--bind", "auto"]
