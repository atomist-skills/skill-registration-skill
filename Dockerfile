# Set up runtime container with dependencies
FROM atomist/skill:alpine_3.16-node_16@sha256:3c28a049c076aead769480ec214d6e2a46f0f8b7fd2f7f66da0e71e47cbaf5d2 as runtime

# skopeo
RUN apk add --no-cache \
 skopeo=1.8.0-r1 \
 && skopeo --version

WORKDIR "/skill"

# Set up build
FROM runtime AS build

COPY . ./

RUN apk add --no-cache \
 npm=8.10.0-r0 \
 python3=3.10.4-r0 \
 make=4.3-r0 \
 g++=11.2.1_git20220219-r2 \
 && NODE_ENV=development npm ci --no-optional \
 && npm run skill \
 && npm cache clean --force \
 && apk del npm python3 make g++ \
 && rm -rf node_modules .git test

# Set up final runtime
FROM runtime

COPY package.json package-lock.json ./

RUN apk add --no-cache \
 npm=8.10.0-r0 \
 python3=3.10.4-r0 \
 make=4.3-r0 \
 g++=11.2.1_git20220219-r2 \
 && npm ci --no-optional \
 && npm cache clean --force \
 && apk del npm python3 make g++

COPY --from=build /skill/ .
COPY --from=build /skill/.atomist/skill.yaml /

ENTRYPOINT ["node", "--no-deprecation", "--no-warnings", "--expose_gc", "--optimize_for_size", "--max-old-space-size=4096", "--always_compact", "/skill/node_modules/.bin/atm-skill"]
CMD ["run"]
