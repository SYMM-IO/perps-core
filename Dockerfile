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

# Copy source and compile
WORKDIR /app/symmio
COPY . .
RUN ln -s /app/node_modules . \
    && cp .env.example .env \
    && ./docker/compile.sh
