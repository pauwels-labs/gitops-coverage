FROM node:18.16.0-alpine3.18

# Create an unprivileged user
RUN adduser --disabled-password --uid 10000 service service

# Create build directory and switch to unprivileged user
WORKDIR /usr/src/service
RUN chown service:service .

# Switch to non-root user
USER service:service

# Cache and install dependencies before loading code
COPY --chown=service:service package.json package-lock.json .
RUN npm ci

# Copy code files
COPY . .

# Start
ENTRYPOINT ["node", "create-markdown.js"]
