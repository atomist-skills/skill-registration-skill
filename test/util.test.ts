/*
 * Copyright © 2020 Atomist, Inc.
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

import { Project } from "@atomist/skill/lib/project/project";
import * as fs from "fs-extra";
import * as os from "os";
import * as path from "path";
import * as assert from "power-assert";

import { getYamlFile } from "../lib/util";

function createMergeChain(count: number): string {
	const lines = ["a0: &a0 { k0: 0 }"];

	for (let index = 1; index < count; index++) {
		lines.push(
			`a${index}: &a${index} { <<: *a${index - 1}, k${index}: ${index} }`,
		);
	}

	lines.push(`skill: *a${count - 1}`);
	return `${lines.join("\n")}\n`;
}

describe("getYamlFile", () => {
	it("rejects skill YAML that exceeds the merge-work limit", async () => {
		const directory = await fs.mkdtemp(
			path.join(os.tmpdir(), "skill-registration-skill-"),
		);
		const fileName = "skill.yaml";
		const project = {
			path: (name: string) => path.join(directory, name),
		} as Project;

		try {
			await fs.writeFile(project.path(fileName), createMergeChain(150));

			let parseError: Error;
			try {
				await getYamlFile(project, fileName);
			} catch (error) {
				parseError = error;
			}

			assert(parseError);
			assert(/maxTotalMergeKeys/.test(parseError.message));
		} finally {
			await fs.remove(directory);
		}
	});
});
