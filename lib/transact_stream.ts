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

import { Contextual, datalog } from "@atomist/skill";

import { RegisterSkill } from "./types";

export async function transactStream(
	ctx: Contextual<any, any>,
	skill: RegisterSkill,
	maturity: string,
	namespace: string,
	name: string,
): Promise<void> {
	await ctx.datalog.transact([
		datalog.entity("docker/repository", "$repository", {
			host: skill.image.repository.host,
			repository: skill.image.repository.name,
		}),
		datalog.entity("deployment/stream", {
			"docker.platform/architecture": "amd64",
			"docker.platform/os": "linux",
			"docker.image/repository": "$repository",
			"image.recorded/digest": skill.image.digest,
			"name": maturity,
			"appname": `${namespace}/${name}`,
		}),
	]);
}
