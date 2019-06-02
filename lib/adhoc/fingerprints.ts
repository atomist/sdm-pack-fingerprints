/*
 * Copyright © 2019 Atomist, Inc.
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
    GraphClient,
    QueryNoCacheOptions,
    logger,
} from "@atomist/automation-client";
import {
    FindLinkedReposWithFingerprint,
    GetFpByBranch,
    AddFingerprints,
    FingerprintInput,
} from "../typings/types";
import { FP } from "@atomist/clj-editors";
import { PushImpactListenerInvocation } from "@atomist/sdm";

export function findTaggedRepos(graphClient: GraphClient): (name: string) => Promise<any> {
    return async name => {
        return graphClient.query<FindLinkedReposWithFingerprint.Query, FindLinkedReposWithFingerprint.Variables>(
            {
                name: "FindLinkedReposWithFingerprint",
                options: QueryNoCacheOptions,
            },
        );
    };
}

/**
 * uses GetFpByBranch query
 *
 * @param graphClient
 */
export function queryFingerprintsByBranchRef(graphClient: GraphClient):
    (repo: string, owner: string, branch: string) => Promise<GetFpByBranch.Analysis[]> {

    return async (repo, owner, branch) => {
        const query: GetFpByBranch.Query = await graphClient.query<GetFpByBranch.Query, GetFpByBranch.Variables>({
            name: "GetFpByBranch",
            options: QueryNoCacheOptions,
            variables: {
                owner,
                repo,
                branch,
            },
        });
        return query.Repo[0].branches[0].commit.analysis;
    };
}

export async function sendFingerprintToAtomist(i: PushImpactListenerInvocation, fps: FP[]): Promise<boolean> {

    const additions: FingerprintInput[] = fps.map(x => {
        return {
            name: x.name,
            sha: x.sha,
            data: x.data,
        }
    });

    try {
        await i.context.graphClient.mutate<AddFingerprints.Mutation, AddFingerprints.Variables>(
            {
                mutation: "AddFingerprints",
                variables: {
                    additions,
                    type: "Atomist",
                    branchId: i.push.branch,
                    repoId: i.push.repo.name,
                    sha: i.push.after.sha,
                }
            }
        );
    } catch (ex) {
        logger.error(`Error sending Fingerprints: ${ex}`)
    }

    return true;
}
