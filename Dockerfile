FROM node:23-bullseye-slim


LABEL version="0.1.5"
LABEL description="Migrate Issues, Wiki from gitlab to github."

WORKDIR /app

# Copy the project contents to the container
COPY . /app


# Install dependencies
RUN npm ci

# Start the process
ENTRYPOINT ["/bin/bash", "-c", "npm run start"]