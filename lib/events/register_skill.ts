/*
 * Copyright © 2023 Atomist, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
	childProcess,
	docker,
	EventContext,
	github,
	guid,
	handle,
	handleError,
	log,
	MappingEventHandler,
	policy,
	project,
	repository,
	status,
	subscription,
	tmpFs,
} from "@atomist/skill";
import { DockerRegistryType } from "@atomist/skill/lib/definition/subscription/common_types";
import { AtomistSkillInput } from "@atomist/skill/lib/definition/subscription/typings/types";
import * as fs from "fs-extra";
import * as _ from "lodash";
import * as path from "path";

import { Configuration } from "../configuration";
import { nextTag } from "../tags";
import { transactStream } from "../transact_stream";
import { RegisterSkill } from "../types";
import {
	AtomistYaml,
	CreateRepositoryIdFromCommit,
	getYamlFile,
} from "../util";
import semver = require("semver/preload");

const ArtifactCache: Record<string, any> = {};

export const handler: MappingEventHandler<
	RegisterSkill,
	{
		image: subscription.datalog.DockerImage;
		commit: subscription.datalog.Commit;
		registry: docker.ExtendedDockerRegistry;
	},
	Configuration
> = {
	map: event => {
		const data = event.map(e =>
			handle.transformData<{
				image: subscription.datalog.DockerImage & {
					manifestList: Array<{ digest: string }>;
				};
				commit: subscription.datalog.Commit;
				registry: docker.ExtendedDockerRegistry;
			}>(e),
		);
		return {
			image: data?.[0]?.image,
			commit: data?.[0]?.commit,
			registry: _.uniqBy(
				data?.map(d => d.registry),
				"id",
			),
		};
	},
	handle: policy.checkHandler({
		id: CreateRepositoryIdFromCommit,
		details: () => ({
			check: {
				name: "register-skill",
				title: "Skill Registration",
				body: `Registering skill`,
				includeAnnotations: false,
				includeBadge: false,
				longRunning: false,
			},
		}),
		execute: async ctx => {
			const commit = ctx.data.commit;

			// download the image so that we can look inside of it
			const [dir, registry] = await downloadImage(ctx);

			// default some skill data
			const defaultSkill: any = await defaults(dir, commit);

			let p = await ctx.project.load(repository.fromCommit(commit), dir);
			// if container doesn't have a skill.yaml in the root; clone repo and use that
			if (!(await fs.pathExists(p.path("skill.yaml")))) {
				p = await ctx.project.clone(p.id, { detachHead: true });
			}

			// load skill.yaml from project (at this point it can be the container filesystem or repo contents)
			const skillYamls = await getYamlFile<AtomistYaml>(p, "skill.yaml");
			const skillNames = [];
			for (const skillYaml of skillYamls) {
				const skill = _.merge({}, defaultSkill, skillYaml.skill);

				skill.version = await version(ctx, skill);
				skill.apiVersion = apiVersion(ctx);
				await inlineDatalogResources(p, skill);
				if (isContainer(ctx)) {
					await createArtifact(skill, ctx, registry);
				} else {
					skill.artifacts = {};
				}

				delete skill.parameterValues;
				log.info(`Registering skill: ${JSON.stringify(skill)}`);

				// eslint-disable-next-line deprecation/deprecation
				await ctx.graphql.mutate("registerSkill.graphql", {
					skill,
				});

				await createTag(skill.version, commit.sha, p);

				await transactStream(
					ctx,
					ctx.data,
					"unstable",
					skill.namespace,
					skill.name,
				);
				skillNames.push(
					`${skill.namespace}/${skill.name}@${skill.version}`,
				);
			}
			return {
				status: status.success(
					`Successfully registered ${skillNames.join(", ")}`,
				),
				conclusion: policy.Conclusion.Success,
				body: `Successfully registered \`${skillNames.join(", ")}\``,
			};
		},
	}),
};

export function apiVersion(
	ctx: EventContext<RegisterSkill, Configuration>,
): string {
	const versionLabel = ctx.data.image.labels?.find(
		l => l.name === "com.docker.skill.api.version",
	)?.value;
	return versionLabel.split("/")[1];
}

export function isContainer(
	ctx: EventContext<RegisterSkill, Configuration>,
): boolean {
	const versionLabel = ctx.data.image.labels?.find(
		l => l.name === "com.docker.skill.api.version",
	)?.value;
	return versionLabel.split("/")[0] === "container";
}

export async function version(
	ctx: EventContext<RegisterSkill, Configuration>,
	skill: AtomistSkillInput,
): Promise<string> {
	const versionImageTag = ctx.data.image.tags?.filter(t =>
		semver.valid(t),
	)?.[0];
	if (versionImageTag) {
		log.info(
			`Skill version set to '${versionImageTag}' because image is tagged`,
		);
		return versionImageTag;
	}
	const versionLabel = ctx.data.image.labels?.find(
		l => l.name === "com.docker.skill.version",
	)?.value;
	if (versionLabel) {
		log.info(
			`Skill version set to '${versionLabel}' because image is labelled`,
		);
		return versionLabel;
	}
	const versionGitTag = ctx.data.commit.refs
		?.filter(r => r.type === "tag")
		?.filter(r => semver.valid(r.name))?.[0]?.name;
	if (versionGitTag) {
		log.info(
			`Skill version set to '${versionGitTag}' because linked commit is tagged`,
		);
		return versionGitTag;
	}
	if (skill.version) {
		log.info(
			`Skill version set to '${skill.version}' because skill.yaml contains version`,
		);
		return skill.version;
	}
	if (!ctx.data["_version"]) {
		const version = await nextTag(repository.fromCommit(ctx.data.commit));
		log.info(`Skill version set to '${version}' because of latest git tag`);
		ctx.data["_version"] = version;
		return version;
	} else {
		const version = ctx.data["_version"];
		log.info(`Skill version set to '${version}' because of latest git tag`);
		return version;
	}
}

export async function defaults(
	cwd: string,
	commit: subscription.datalog.Commit,
): Promise<AtomistSkillInput> {
	const description = `Atomist Skill registered from ${commit.repo.org.name}/${commit.repo.name}`;
	const longDescription = description;
	const readme = Buffer.from(description).toString("base64");

	let iconUrl = `https://github.com/${commit.repo.org.name}.png`;
	const icons = await project.globFiles(cwd, "icon.svg");
	if (icons.length > 0) {
		const iconFile = (await fs.readFile(path.join(cwd, icons[0]))).toString(
			"base64",
		);
		iconUrl = `data:image/svg+xml;base64,${iconFile}`;
	}
	const namespace =
		commit.repo.org.name === "atomist-skills"
			? "Atomist"
			: commit.repo.org.name;
	return {
		namespace: namespace.toLowerCase(),
		name: commit.repo.name.toLowerCase(),
		version: undefined,
		displayName: commit.repo.name,
		author: namespace,
		description,
		longDescription,
		readme,
		iconUrl,
		homepageUrl: `https://github.com/${commit.repo.org.name}/${commit.repo.name}`,
		license: "Apache-2.0",
		artifacts: undefined,
		commitSha: commit.sha,
		repoId: commit.repo.sourceId,
	};
}

async function downloadImage(
	ctx: EventContext<RegisterSkill, Configuration>,
): Promise<[string, docker.ExtendedDockerRegistry]> {
	const host = ctx.data.image.repository.host;
	const sortedRegistries = _.orderBy(
		ctx.data.registry,
		[
			r => {
				switch (r?.type) {
					case subscription.datalog.DockerRegistryType.Ecr:
						return host.includes(".ecr.") ? 0 : 1;
					case subscription.datalog.DockerRegistryType.Gcr:
						return host.includes("gcr.io") ? 0 : 1;
					case subscription.datalog.DockerRegistryType.Gar:
						return host.includes("pkg.dev") ? 0 : 1;
					case subscription.datalog.DockerRegistryType.Ghcr:
						return host.includes("ghcr.io") ? 0 : 1;
					case subscription.datalog.DockerRegistryType.DockerHub:
						return host === "hub.docker.com" ? 0 : 1;
					default:
						return 1;
				}
			},
		],
		["asc"],
	);
	return docker.doAuthed<[string, docker.ExtendedDockerRegistry]>(
		ctx,
		sortedRegistries,
		async registry => {
			log.info("Downloading image");
			const tmpDir = await tmpFs.createDir(ctx);
			const imageNameWithDigest = fullImageName(ctx.data.image);
			const args = [
				imageNameWithDigest,
				tmpDir,
				"--include=skill.yaml",
				"--include=datalog",
			];
			const result = await childProcess.spawnPromise("undock", args);
			if (result.status !== 0) {
				throw new Error("Failed to download layers");
			}
			log.info(`Successfully downloaded image`);
			return [tmpDir, registry] as any;
		},
	);
}

async function copyImage(
	ctx: EventContext<RegisterSkill, Configuration>,
	skill: AtomistSkillInput,
	registry: docker.ExtendedDockerRegistry,
): Promise<string> {
	const newImageName = `us-east1-docker.pkg.dev/scout-artifact-registry/skills/${skill.namespace}-${skill.name}:${skill.version}.skill`;
	const gcrRegistry: docker.ExtendedDockerRegistry = {
		id: guid(),
		type: DockerRegistryType.Gar,
		serviceAccount:
			"skill-registration-skill@scout-artifact-registry.iam.gserviceaccount.com",
		serverUrl: "us-east1-docker.pkg.dev",
	} as any;

	if (ArtifactCache[newImageName]) {
		return newImageName;
	}

	return docker.doAuthed<string>(ctx, [[registry, gcrRegistry]], async () => {
		log.info("Copying image");
		const args = [
			"copy",
			`docker://${fullImageName(ctx.data.image)}`,
			`docker://${newImageName}`,
		];

		const result = await childProcess.spawnPromise("skopeo", args);
		if (result.status !== 0) {
			log.error(result.stderr);
			throw new Error("Failed to copy image");
		}
		log.info(`Successfully copied image to ${newImageName}`);
		ArtifactCache[newImageName] = true;
		return newImageName;
	});
}

export function imageName(
	image: Pick<subscription.datalog.DockerImage, "repository">,
): string {
	return image.repository.host !== "hub.docker.com" &&
		image.repository.host !== "docker.io"
		? `${image.repository.host}/${image.repository.name}`
		: image.repository.name;
}

export function fullImageName(
	image: Pick<
		subscription.datalog.DockerImage & {
			manifestList: Array<{ digest: string }>;
		},
		"digest" | "tags" | "repository" | "manifestList"
	>,
): string {
	let digest = image.digest;
	if (image.manifestList?.length > 0) {
		digest = image.manifestList[0].digest;
	}
	return `${imageName(image)}${
		!digest && image.tags?.length > 0 ? `:${image.tags[0]}` : ""
	}${digest ? `@${digest}` : ""}`;
}

type DatalogSubscription = {
	name: string;
	query: string;
	limit?: number;
};

async function getDatalogSubscriptionFileMatches(
	p: project.Project,
	matchPath: string,
): Promise<Array<DatalogSubscription>> {
	return await project.withGlobMatches<{
		name: string;
		query: string;
		limit?: number;
	}>(p, matchPath, async file => {
		const filePath = p.path(file);
		const fileName = path.basename(filePath);
		const extName = path.extname(fileName);
		return {
			query: (await fs.readFile(filePath)).toString(),
			name: fileName.replace(extName, ""),
		};
	});
}

function updateSubscriptions(
	datalogSubscriptions: Array<DatalogSubscription>,
	updates: Array<DatalogSubscription>,
): void {
	updates.forEach(d => {
		const eds = datalogSubscriptions.find(ds => d.name === ds.name);
		if (eds) {
			eds.query = d.query;
			eds.limit = d.limit;
		} else {
			datalogSubscriptions.push(d);
		}
	});
}

export async function inlineDatalogResources(
	p: project.Project,
	skill: AtomistYaml["skill"],
): Promise<void> {
	const datalogSubscriptions: Array<DatalogSubscription> = [];

	// common subscriptions
	datalogSubscriptions.push(
		...(await getDatalogSubscriptionFileMatches(
			p,
			"datalog/subscription/*.edn",
		)),
	);

	// subscription paths defined in yaml
	for (const subscriptionPath of skill.datalogSubscriptionPaths || []) {
		const subscriptionPathMatches = await getDatalogSubscriptionFileMatches(
			p,
			`datalog/subscription/${subscriptionPath}`,
		);
		updateSubscriptions(datalogSubscriptions, subscriptionPathMatches);
	}
	delete skill.datalogSubscriptionPaths;

	// subscriptions defined in yaml
	updateSubscriptions(datalogSubscriptions, skill.datalogSubscriptions || []);
	skill.datalogSubscriptions = datalogSubscriptions;

	const schemata = [...(skill.schemata || [])];
	if (schemata.length === 0) {
		schemata.push(
			...(await project.withGlobMatches<{
				name: string;
				schema: string;
			}>(p, "datalog/schema/*.edn", async file => {
				const filePath = path.join(p.path(), file);
				const fileName = path.basename(filePath);
				const extName = path.extname(fileName);
				const schema = (await fs.readFile(filePath)).toString();
				return {
					schema,
					name: fileName.replace(extName, ""),
				};
			})),
		);
	}
	skill.schemata = schemata;
}

async function createTag(
	version: string,
	sha: string,
	p: project.Project,
): Promise<void> {
	const api = github.api(p.id);
	try {
		await api.git.getRef({
			owner: p.id.owner,
			repo: p.id.repo,
			ref: `refs/tags/${version}`,
		});
	} catch (e) {
		// tag doesn't exist yet; let's create it
		await handleError(async () => {
			await api.git.createTag({
				owner: p.id.owner,
				repo: p.id.repo,
				tag: version,
				object: sha,
				type: "commit",
				message: `v${version}`,
				tagger: {
					name: "Atomist Bot",
					email: "bot@atomist.com",
					date: new Date().toISOString(),
				},
			});
			await api.git.createRef({
				owner: p.id.owner,
				repo: p.id.repo,
				sha,
				ref: `refs/tags/${version}`,
			});
		});
	}
}

async function createArtifact(
	skill: AtomistSkillInput,
	ctx: EventContext<RegisterSkill, Configuration>,
	registry: docker.ExtendedDockerRegistry,
): Promise<void> {
	const artifact = skill.artifacts?.docker?.[0] || ({} as any);
	artifact.name = artifact.name || "skill";
	if (
		(ctx.data.image.repository.host === "gcr.io" &&
			ctx.data.image.repository.name.startsWith(
				"atomist-container-skills/",
			)) ||
		(ctx.data.image.repository.host === "us-east1-docker.pkg.dev" &&
			ctx.data.image.repository.name.startsWith(
				"scout-artifact-registry/",
			)) ||
		(ctx.data.image.repository.host === "hub.docker.com" &&
			ctx.data.image.repository.name.startsWith("atomist/"))
	) {
		artifact.image = fullImageName(ctx.data.image);
	} else {
		artifact.image = await copyImage(ctx, skill, registry);
	}

	if (!(skill.artifacts?.docker?.length > 0)) {
		skill.artifacts = {
			docker: [artifact],
		};
	} else {
		skill.artifacts.docker[0] = artifact;
	}
}
