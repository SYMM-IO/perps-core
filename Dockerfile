# Project: symmio

FROM node:lts

######################################################################
# LABELS
######################################################################
ARG COMMIT_ID
ARG COMMIT_TIMESTAMP
ARG COMMIT_AUTHOR
ARG BUILD_APPLICATION
ARG BUILD_DATE

LABEL org.vcs.CommitId=${COMMIT_ID} \
      org.vcs.CommitTimestamp=${COMMIT_TIMESTAMP} \
      org.vcs.CommitAuthor=${COMMIT_AUTHOR} \
      org.build.Application=${BUILD_APPLICATION} \
      org.build.Date=${BUILD_DATE}

######################################################################
# BUILD
######################################################################
RUN npm config set fetch-retries 10 \
    && npm config set fetch-retry-mintimeout 20000

# Install dependencies first (cached unless package.json changes)
WORKDIR /app
COPY package.json ./
RUN npm install --ignore-scripts

# Pre-download solc compiler (cached unless hardhat config or tasks change)
WORKDIR /app/symmio
COPY hardhat.config.ts ./
# tasks/ is required because hardhat.config.ts imports from it; without it the
# config fails to load and solc won't be downloaded. scripts/ carries the
# remaining standalone operator scripts, which are run inside the image.
COPY tasks/ tasks/
COPY scripts/ scripts/
RUN ln -s /app/node_modules . \
    && npx hardhat compile

# Copy source and compile
COPY .env.example .env
COPY . .
RUN ./docker/compile.sh
