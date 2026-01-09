# This Dockerfile is used to set up a container environment with all the required
# tools to use this project. You only need to provide the necessary environment
# variables, as described in the README.
#
# Docker version that I used: 20.10.17
#
# If you're interested in testing other base images, take a look at this reference:
# https://github.com/BretFisher/nodejs-rocks-in-docker
FROM node:22-bullseye-slim


LABEL version="0.1.5"
LABEL description="Migrate Issues, Wiki from gitlab to github."

WORKDIR /app

# Copy the project contents to the container
COPY . /app


# Install dependencies
RUN npm ci

# Start the process
ENTRYPOINT ["/bin/bash", "-c", "npm run start"]