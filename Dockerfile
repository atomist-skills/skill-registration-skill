# Set up runtime container with dependencies
FROM atomist/skill:alpine_3.16-node_16@sha256:db6b383da5bc60839a7635d0d7e09940ee9b5b77d061f53fa77b2ddca4d33fdd as runtime

# skopeo
RUN apk add --no-cache \
 skopeo \
 && skopeo --version

# container-diff
RUN curl -sLO https://storage.googleapis.com/container-diff/latest/container-diff-linux-amd64 \
 && chmod +x container-diff-linux-amd64 \
 && mv container-diff-linux-amd64 /usr/bin/container-diff \
 && container-diff version

WORKDIR "/skill"

# Set up build
FROM runtime AS build

COPY . ./

RUN apk add --no-cache \
 npm \
 python3 \
 make \
 g++ \
 && NODE_ENV=development npm ci --no-optional \
 && npm run skill \
 && npm cache clean --force \
 && apk del npm python3 make g++ \
 && rm -rf node_modules .git test

# Set up final runtime
FROM runtime

LABEL com.docker.skill.api.version="container/v1"
COPY --from=build /skill/ .
COPY --from=build /skill/.atomist/skill.yaml /

COPY package.json package-lock.json ./

RUN apk add --no-cache \
 npm \
 python3 \
 make \
 g++ \
 && npm ci --no-optional \
 && npm cache clean --force \
 && apk del npm python3 make g++


ENTRYPOINT ["node", "--no-deprecation", "--no-warnings", "--expose_gc", "--optimize_for_size", "--max-old-space-size=4096", "--always_compact", "/skill/node_modules/.bin/atm-skill"]
CMD ["run"]
