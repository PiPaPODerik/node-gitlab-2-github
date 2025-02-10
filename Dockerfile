FROM node:16-bullseye-slim

ARG USERNAME=migrator
ARG USER_UID=2000
ARG USER_GID=$USER_UID

LABEL version="0.1.5"
LABEL description="Migrate Issues, Wiki from gitlab to github."

WORKDIR /app

# Add a non-root user, so later we can explore methods to scale
# privileges within this container.
# https://code.visualstudio.com/remote/advancedcontainers/add-nonroot-user#_creating-a-nonroot-user
RUN groupadd --gid $USER_GID $USERNAME
RUN useradd --uid $USER_UID --gid $USER_GID -m $USERNAME

# Copy the project contents to the container
COPY --chown=$USER_UID:$USER_GID . /app

# Ensure the inputs-outputs directory has the correct permissions
RUN mkdir -p /app/inputs-outputs && chmod -R 777 /app/inputs-outputs

# Change ownership of the /app directory to the non-root user
RUN chown -R $USERNAME:$USERNAME /app

USER $USERNAME

# Install dependencies
RUN npm ci

# Start the process
ENTRYPOINT ["/bin/bash", "-c", "npm run start"]