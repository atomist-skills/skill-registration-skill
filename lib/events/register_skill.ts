/*
 * Copyright © 2022 Atomist, Inc.
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
	handle,
	log,
	MappingEventHandler,
	policy,
	project,
	repository,
	status,
	subscription,
	tmpFs,
} from "@atomist/skill";
import * as fs from "fs-extra";
import * as _ from "lodash";
import * as path from "path";

import { Configuration } from "../configuration";
import { nextTag } from "../tags";
import { ExtendedDockerRegistry, RegisterSkill } from "../types";
import { AtomistYaml, getYamlFile } from "../util";

export const handler: MappingEventHandler<
	RegisterSkill,
	{
		image: subscription.datalog.DockerImage;
		commit: subscription.datalog.Commit;
		registry: ExtendedDockerRegistry;
	},
	Configuration
> = {
	map: event => {
		const data = event.map(e =>
			handle.transformData<{
				image: subscription.datalog.DockerImage;
				commit: subscription.datalog.Commit;
				registry: ExtendedDockerRegistry;
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
		id: ctx => repository.fromRepo(ctx.data.commit.repo),
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
			const image = ctx.data.image;
			const imageDir = await downloadImage(ctx, ctx.data);
			const p = await ctx.project.load(
				repository.fromRepo(ctx.data.commit.repo),
				imageDir,
			);

			let skill: any = defaults(imageDir, ctx.data.commit);
			if (await fs.pathExists(p.path("skill.yaml"))) {
				const skillYaml = (
					await getYamlFile<AtomistYaml>(p, "skill.yaml")
				).doc.skill;
				skill = _.merge(skill, skillYaml, {});
			}
			skill.namespace =
				image.labels?.find(l => l.name === "com.docker.skill.namespace")
					?.value || skill.namespace;
			skill.name =
				image.labels?.find(l => l.name === "com.docker.skill.name")
					?.value || skill.name;
			skill.version =
				image.labels?.find(l => l.name === "com.docker.skill.version")
					?.value || (await nextTag(p.id));
			skill.repoId = ctx.data.commit.repo.sourceId;
			skill.commitSha = ctx.data.commit.sha;

			const datalogSubscriptions = [];
			datalogSubscriptions.push(
				...(await project.withGlobMatches<{
					name: string;
					query: string;
					limit?: number;
				}>(imageDir, "datalog/subscription/*.edn", async file => {
					const filePath = path.join(imageDir, file);
					const fileName = path.basename(filePath);
					const extName = path.extname(fileName);
					return {
						query: (
							await fs.readFile(path.join(imageDir, file))
						).toString(),
						name: fileName.replace(extName, ""),
					};
				})),
			);
			(skill.datalogSubscriptions || []).forEach(d => {
				const eds = datalogSubscriptions.find(ds => d.name === ds.name);
				if (eds) {
					eds.query = d.query;
					eds.limit = d.limit;
				} else {
					datalogSubscriptions.push(d);
				}
			});
			skill.datalogSubscriptions = datalogSubscriptions;

			const schemata = [...(skill.schemata || [])];
			if (schemata.length === 0) {
				schemata.push(
					...(await project.withGlobMatches<{
						name: string;
						schema: string;
					}>(imageDir, "datalog/schema/*.edn", async file => {
						const filePath = path.join(imageDir, file);
						const fileName = path.basename(filePath);
						const extName = path.extname(fileName);
						const schema = (
							await fs.readFile(path.join(imageDir, file))
						).toString();
						return {
							schema,
							name: fileName.replace(extName, ""),
						};
					})),
				);
			}
			skill.schemata = schemata;

			const artifact = skill.artifacts?.docker?.[0] || ({} as any);
			artifact.name = artifact.name || "skill";
			if (
				!(
					ctx.data.image.repository.host === "gcr.io" &&
					ctx.data.image.repository.name.startsWith(
						"atomist-container-skills/",
					)
				)
			) {
				const newImageName = await copyImage(
					ctx,
					skill,
					skill.namespace,
					skill.name,
					skill.verison,
				);
				artifact.name = newImageName;
			} else {
				artifact.name = fullImageName(image);
			}

			if (!(skill.artifacts?.docker?.length > 0)) {
				skill.artifacts = {
					docker: [artifact],
				};
			} else {
				skill.artifacts.docker[0] = artifact;
			}

			// eslint-disable-next-line deprecation/deprecation
			await ctx.graphql.mutate("registerSkill.graphql", {
				skill,
			});

			await github.api(p.id).git.createTag({
				owner: p.id.owner,
				repo: p.id.repo,
				tag: skill.version,
				object: ctx.data.commit.sha,
				type: "commit",
				message: `v${skill.version}`,
				tagger: {
					name: "Atomist Bot",
					email: "bot@atomist.com",
					date: new Date().toISOString(),
				},
			});

			return {
				status: status.success(
					`Successfully registered ${skill.namespace}/${skill.name}@${skill.version}`,
				),
				conclusion: policy.Conclusion.Success,
				body: `Successfully registered \`${skill.namespace}/${skill.name}@${skill.version}\``,
			};
		},
	}),
};

async function defaults(
	cwd: string,
	commit: subscription.datalog.Commit,
): Promise<any> {
	const description = `Atomist Skill registered from ${commit.repo.org.name}/${commit.repo.name}`;
	const longDescription = description;
	const readme = description;

	let iconUrl = `https://github.com/${commit.repo.org.name}.png`;
	const icons = await project.globFiles(cwd, "icon.svg");
	if (icons.length > 0) {
		const iconFile = (await fs.readFile(path.join(cwd, icons[0]))).toString(
			"base64",
		);
		iconUrl = `data:image/svg+xml;base64,${iconFile}`;
	}

	return {
		displayName: commit.repo.name,
		author:
			commit.repo.org.name === "atomist-skills"
				? "Atomist"
				: commit.repo.org.name,
		description,
		longDescription,
		readme,
		iconUrl,
		homepageUrl: `https://github.com/${commit.repo.org.name}/${commit.repo.name}`,
		license: "Apache-2.0",
	};
}

async function downloadImage(
	ctx: EventContext,
	skill: RegisterSkill,
): Promise<string> {
	const host = skill.image.repository.host;
	const sortedRegistries = _.orderBy(
		skill.registry,
		[
			r => {
				switch (r?.type) {
					case subscription.datalog.DockerRegistryType.Ecr:
						return host.includes(".ecr.") ? 0 : 1;
					case subscription.datalog.DockerRegistryType.Gcr:
						return host.includes("gcr.io") ? 0 : 1;
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
	return docker.doAuthed<string>(ctx, sortedRegistries, async () => {
		log.info("Downloading image");
		const tmpDir = await tmpFs.createDir(ctx);
		const args = [
			"copy",
			`docker://${fullImageName(skill.image)}`,
			`dir://${tmpDir}`,
		];

		const result = await childProcess.spawnPromise("skopeo", args);
		if (result.status !== 0) {
			throw new Error("Failed to copy image");
		}
		return tmpDir;
	});
}

async function copyImage(
	ctx: EventContext,
	skill: RegisterSkill,
	namespace: string,
	name: string,
	version: string,
): Promise<string> {
	const host = skill.image.repository.host;
	const sortedRegistries = _.orderBy(
		skill.registry,
		[
			r => {
				switch (r?.type) {
					case subscription.datalog.DockerRegistryType.Ecr:
						return host.includes(".ecr.") ? 0 : 1;
					case subscription.datalog.DockerRegistryType.Gcr:
						return host.includes("gcr.io") ? 0 : 1;
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
	const newImageName = `gcr.io/atomist-container-skills/${namespace}-${name}:${version}`;
	return docker.doAuthed<string>(ctx, sortedRegistries, async () => {
		log.info("Copying image");
		const args = [
			"copy",
			`docker://${fullImageName(skill.image)}`,
			`docker://${newImageName}`,
		];

		const result = await childProcess.spawnPromise("skopeo", args);
		if (result.status !== 0) {
			throw new Error("Failed to copy image");
		}
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
		subscription.datalog.DockerImage,
		"digest" | "tags" | "repository"
	>,
): string {
	return `${imageName(image)}${
		!image.digest && image.tags?.length > 0 ? `:${image.tags[0]}` : ""
	}${image.digest ? `@${image.digest}` : ""}`;
}
