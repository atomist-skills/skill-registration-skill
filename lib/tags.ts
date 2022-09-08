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

import { github, log, repository, secret } from "@atomist/skill";
import * as semver from "semver";

export async function nextTag(
	id: repository.AuthenticatedRepositoryId<
		secret.GitHubAppCredential | secret.GitHubCredential
	>,
): Promise<string> {
	const api = github.api(id);
	const tags = [];
	for await (const response of api.paginate.iterator(api.repos.listTags, {
		owner: id.owner,
		repo: id.repo,
		per_page: 200,
	})) {
		tags.push(...response.data.map(t => t.name));
	}
	const sortedTags = tags
		.filter(t => semver.valid(t))
		.sort((t1, t2) => {
			return semver.compare(t2, t1);
		});
	const latestTag = sortedTags[0] || "0.1.0";
	const nextTag = semver.inc(latestTag, "patch");
	log.debug(
		`Calculated next tag '${nextTag}' from current tag '${latestTag}'`,
	);
	return nextTag;
}
