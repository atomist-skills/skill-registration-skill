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

import { handle } from "@atomist/skill";
import { AtomistSkillInput } from "@atomist/skill/lib/definition/subscription/typings/types";
import { Project } from "@atomist/skill/lib/project/project";
import * as fs from "fs-extra";
import * as yaml from "js-yaml";

import { Configuration } from "./configuration";
import { RegisterSkill } from "./types";

export interface AtomistYaml {
	skill: AtomistSkillInput & { datalogSubscriptionPaths?: string[] };
}

export const AtomistYamlFileName = "skill.package.yaml";

export async function getYamlFile<D = any>(
	project: Project,
	name: string = AtomistYamlFileName,
): Promise<Array<D>> {
	const docs = [];
	if (await fs.pathExists(project.path(name))) {
		const content = (await fs.readFile(project.path(name))).toString();
		const yamlDocs: any = yaml.safeLoadAll(content);
		docs.push(...yamlDocs);
	}
	return docs;
}

export const CreateRepositoryIdFromCommit: handle.CreateRepositoryId<
	RegisterSkill,
	Configuration
> = ctx => ({
	sha: ctx.data.commit.sha,
	owner: ctx.data.commit.repo.org.name,
	repo: ctx.data.commit.repo.name,
	credential: {
		token: ctx.data.commit.repo.org.installationToken,
		scopes: [],
	},
	sourceId: ctx.data.commit.repo.sourceId,
});
