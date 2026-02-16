# CLAUDE.md - skill-registration-skill

## Overview

An Atomist Skill that registers container-based skills when new Docker images with skill API labels are pushed. It watches for Docker images labeled with `com.docker.skill.api.version` on default branches and registers them as skills via GraphQL mutations.

## Tech Stack

- **Language**: TypeScript
- **Runtime**: Node.js (>=8.2.0)
- **Test Framework**: Mocha with power-assert
- **Linting**: ESLint + Prettier
- **Build**: tsc, npm-run-all
- **Container**: Docker (Alpine-based with skopeo and undock)
- **Skill Framework**: `@atomist/skill`

## Project Structure

```
skill.ts                    # Skill definition (category: DevOps, container skill)
Dockerfile                  # Container build (Alpine + skopeo + undock)
package.json                # Node.js dependencies and scripts
lib/
  configuration.ts          # Skill configuration handling
  events/
    register_skill.ts       # Main event handler for skill registration
  tags.ts                   # Tag utilities
  transact_stream.ts        # Stream transaction utilities
  types.ts                  # TypeScript type definitions
  util.ts                   # General utilities
datalog/subscription/
  register_skill.edn        # Datalog subscription for Docker images with skill labels
graphql/
  mutation/
    registerSkill.graphql   # GraphQL mutation for registering skills
test/
  empty.test.ts             # Placeholder test
```

## Key Commands

```bash
npm install           # Install dependencies
npm run build         # Full build: clean, compile, test, lint, doc
npm run compile       # Compile TypeScript
npm test              # Run tests (mocha)
npm run skill         # Compile, test, and generate skill metadata
```

## Key Patterns

- Uses a Datalog subscription (`register_skill.edn`) to watch for Docker images with `com.docker.skill.api.version` labels (container/v1, container/v2, extension/v2)
- Only registers images from commits on the repo's default branch
- Uses skopeo and undock tools in the container for image inspection
- Registers skills via the `registerSkill` GraphQL mutation
