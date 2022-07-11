/*
 * Copyright © 2021 Atomist, Inc.
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

import { CapabilityScope, Category, parameter, skill } from "@atomist/skill";

export const Skill = skill({
	categories: [Category.DevOps],

	containers: {
		package: {
			image: "gcr.io/atomist-container-skills/skill-registration-skill:c414c26dca04070bb2328b14ea427de3560dc6be",
			resources: {
				limit: {
					cpu: 1,
					memory: 5000,
				},
				request: {
					cpu: 1,
					memory: 5000,
				},
			},
		},
	},

	parameters: {
		repos: parameter.repoFilter(),
	},

	capabilities: {
		requires: [
			{
				namespace: "atomist",
				name: "DockerRegistry",
				minRequired: 0,
				usage: "analysis",
				displayName: "Docker registry",
				scopes: [CapabilityScope.Configuration],
			},
		],
	},
});
