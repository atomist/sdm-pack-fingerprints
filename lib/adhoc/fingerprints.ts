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
    logger,
    QueryNoCacheOptions,
} from "@atomist/automation-client";
import {
    partitionByFeature,
} from "@atomist/clj-editors";
import { PushImpactListenerInvocation } from "@atomist/sdm";
import { FP } from "../machine/Aspect";
import {
    AddFingerprints,
    FindOtherRepos,
    GetFpByBranch,
    RepoBranchIds,
} from "../typings/types";

// TODO this is not actually using the new query yet (filtering is happening in memory)
export function findTaggedRepos(graphClient: GraphClient): (type: string, name: string) => Promise<FindOtherRepos.Query> {
    return async (type, name) => {
        return graphClient.query<FindOtherRepos.Query, FindOtherRepos.Variables>(
            {
                name: "FindOtherRepos",
                options: QueryNoCacheOptions,
                variables: {
                    type,
                    name,
                },
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

export async function sendFingerprintToAtomist(i: PushImpactListenerInvocation, fps: FP[], previous: Record<string, FP>): Promise<boolean> {

    try {
        // TODO use i.push and new sdm core to skip over this query entirely
        const ids: RepoBranchIds.Query = await i.context.graphClient.query<RepoBranchIds.Query, RepoBranchIds.Variables>(
            {
                name: "RepoBranchIds",
                variables: {
                    branch: i.push.branch,
                    owner: i.push.repo.owner,
                    repo: i.push.repo.name,
                },
            },
        );

        await partitionByFeature(fps, async partitioned => {
            await Promise.all(partitioned.map(async ({ type, additions }) => {
                logger.info(`Upload ${additions.length} fingerprints of type ${type}`);
                await i.context.graphClient.mutate<AddFingerprints.Mutation, AddFingerprints.Variables>(
                    {
                        name: "AddFingerprints",
                        variables: {
                            additions,
                            type,
                            branchId: ids.Repo[0].branches[0].id,
                            repoId: ids.Repo[0].id,
                            sha: i.push.after.sha,
                        },
                    },
                );
            }));
        });
    } catch (ex) {
        logger.error(`Error sending fingerprints: ${ex.message}`);
    }

    return true;
}
