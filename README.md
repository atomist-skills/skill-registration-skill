# skill-registration-skill

An Atomist Skill that automatically registers container-based skills when new Docker images with skill API labels are pushed. It watches for images labeled with `com.docker.skill.api.version` on default branches and registers them as skills.

## Tech Stack

- TypeScript / Node.js
- Mocha (test framework)
- ESLint + Prettier (linting/formatting)
- Docker (Alpine-based container with skopeo and undock)
- `@atomist/skill` SDK

## Building and Testing

```bash
npm install           # Install dependencies
npm run build         # Full build: clean, compile, test, lint, doc
npm run compile       # Compile TypeScript only
npm test              # Run tests
npm run skill         # Compile, test, and generate skill metadata
```

## Key Notes

- Uses a Datalog subscription (`register_skill.edn`) to watch for Docker images with `com.docker.skill.api.version` labels (container/v1, container/v2, extension/v2)
- Only registers images from commits on the repository's default branch
- Uses skopeo and undock tools in the container for image inspection
- Registers skills via the `registerSkill` GraphQL mutation
- Skill definition is in `skill.ts` (category: DevOps, container-based)

## License

Apache-2.0
