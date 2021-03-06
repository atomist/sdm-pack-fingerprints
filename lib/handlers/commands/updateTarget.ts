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
    FailurePromise,
    HandlerContext,
    logger,
    MappedParameter,
    MappedParameters,
    menuForCommand,
    Parameter,
    Parameters,
    QueryNoCacheOptions,
} from "@atomist/automation-client";
import {
    actionableButton,
    CommandHandlerRegistration,
    slackQuestionMessage,
    slackSuccessMessage,
    SoftwareDeliveryMachine,
} from "@atomist/sdm";
import {
    codeLine,
    italic,
} from "@atomist/slack-messages";
import * as _ from "lodash";
import { Aspect } from "../../..";
import { queryFingerprintsByBranchRef } from "../../adhoc/fingerprints";
import {
    deleteFPTarget,
    fromName,
    setFPTarget,
    toName,
} from "../../adhoc/preferences";
import {
    ManagePolicyAction,
    PolicyLog,
    sendPolicyLog,
} from "../../log/policyLog";
import {
    FP,
    Vote,
} from "../../machine/Aspect";
import {
    displayName,
    displayValue,
} from "../../machine/Aspects";
import {
    GetAllFpsOnSha,
    GetFpByBranch,
    GetFpBySha,
} from "../../typings/types";
import { askAboutBroadcast } from "./broadcast";

@Parameters()
export class SetTargetFingerprintFromLatestMasterParameters {
    @MappedParameter(MappedParameters.GitHubOwner)
    public owner: string;

    @MappedParameter(MappedParameters.GitHubRepository)
    public repo: string;

    @MappedParameter(MappedParameters.GitHubRepositoryProvider)
    public providerId: string;

    @Parameter({
        required: true,
        pattern: /[\w-]+::[\w-]+(::[\w-]+)?/,
        description: `Please enter the fingerprint (format type::name)`,
        displayName: `Please enter the fingerprint (format type::name)`,
    })
    public fingerprint: string;

    @Parameter({ required: false, displayable: false })
    public branch: string = "master";

    @Parameter({ required: false, displayable: false })
    public msgId?: string;
}

/**
 * bootstraps a Fingerprint from a project
 * looks up the fingerprint before setting it but name of fingerprint is in the parameter list
 */
export function setTargetFingerprintFromLatestMaster(sdm: SoftwareDeliveryMachine, aspects: Aspect[]):
    CommandHandlerRegistration<SetTargetFingerprintFromLatestMasterParameters> {
    return {
        name: "SetTargetFingerprintFromLatestMaster",
        intent: [
            `set fingerprint target from master ${sdm.configuration.name.replace("@", "")}`,
            `setFingerprintGoalFromMaster ${sdm.configuration.name.replace("@", "")}`,
        ],
        description: "set a new target for a team to consume a particular version",
        paramsMaker: SetTargetFingerprintFromLatestMasterParameters,
        listener: async cli => {

            const branch = cli.parameters.branch || "master";

            const query: GetFpByBranch.Query = await cli.context.graphClient.query<GetFpByBranch.Query, GetFpByBranch.Variables>({
                name: "GetFpByBranch",
                options: QueryNoCacheOptions,
                variables: {
                    owner: cli.parameters.owner,
                    repo: cli.parameters.repo,
                    branch,
                },
            });
            const { type, name } = fromName(cli.parameters.fingerprint);
            const fp: GetFpByBranch.Analysis = query.Repo[0].branches[0].commit.analysis.find(x => x.name === name && x.type === type);
            logger.info(`found sha ${fp.sha}`);
            fp.data = JSON.parse(fp.data);

            if (!!fp.sha) {
                await (setFPTarget(cli.context.graphClient))(fp.type, fp.name, fp);
                return askAboutBroadcast(
                    cli,
                    aspects,
                    {
                        name: fp.name,
                        type: fp.type,
                        data: fp.data,
                        sha: fp.sha,
                    },
                    cli.parameters.msgId);
            } else {
                return FailurePromise;
            }
        },
    };
}

@Parameters()
export class UpdateTargetFingerprintParameters {

    @Parameter({ required: false, displayable: false })
    public msgId?: string;

    // sha of fingerprint
    @Parameter({ required: true })
    public sha: string;

    @Parameter({ required: true })
    public targetfingerprint: string;

    @Parameter({ required: false, type: "boolean" })
    public broadcast: boolean;

    @Parameter({ required: false, displayable: true })
    public reason: string;

}

export const UpdateTargetFingerprintName = "RegisterTargetFingerprint";

/**
 * Used by MessageMaker to implement SetNewTarget
 * (knows the name, type, and sha of the potential target fingerprint)
 */
export function updateTargetFingerprint(sdm: SoftwareDeliveryMachine,
                                        aspects: Aspect[]): CommandHandlerRegistration<UpdateTargetFingerprintParameters> {
    return {
        name: UpdateTargetFingerprintName,
        description: "set a new target for a team to consume a particular version",
        paramsMaker: UpdateTargetFingerprintParameters,
        intent: [
            `register fingerprint target ${sdm.configuration.name.replace("@", "")}`,
        ],
        listener: async cli => {

            const { type, name } = fromName(cli.parameters.targetfingerprint);
            const query: GetFpBySha.Query = await cli.context.graphClient.query<GetFpBySha.Query, GetFpBySha.Variables>(
                {
                    options: QueryNoCacheOptions,
                    name: "GetFpBySha",
                    variables: {
                        type,
                        name,
                        sha: cli.parameters.sha,
                    },
                },
            );
            const fp: GetFpBySha.SourceFingerprint = query.SourceFingerprint;
            fp.data = JSON.parse(fp.data);

            const fingerprint: FP = {
                name: fp.name,
                type: fp.type,
                data: fp.data,
                sha: fp.sha,
                displayName: fp.displayName,
                displayValue: fp.displayValue,
                displayType: fp.displayType,
            };

            await (setFPTarget(cli.context.graphClient))(type, name, fingerprint);

            const author = _.get(cli.context.source, "slack.user.id") || _.get(cli.context.source, "web.identity.sub");

            const log: PolicyLog = {
                type,
                name,

                manage: {
                    action: ManagePolicyAction.Set,
                    author,
                    reason: cli.parameters.reason || `Set target to ${fp.displayValue}`,
                    targetSha: fp.sha,
                    targetValue: fp.displayValue,
                },
            };
            await sendPolicyLog(log, cli.context);

            if (!!cli.parameters.broadcast) {
                return askAboutBroadcast(cli, aspects, fingerprint, cli.parameters.msgId);
            } else {
                await cli.addressChannels(slackSuccessMessage(
                    "Set Target",
                    `Successfully set new target ${italic(fp.displayName)} ${codeLine(fp.displayValue)}`));
            }
        },
    };
}

@Parameters()
export class SetTargetFingerprintParameters {

    // fp is the JSONified version of the entire Fingerprint
    @Parameter({ required: true, displayable: false, control: "textarea", pattern: /.*/ })
    public fp: string;

    @Parameter({ required: false, displayable: false })
    public msgId?: string;
}

/**
 * Used by other diff handlers to change or bootstrap a target because coordinates have changed
 * (knows the whole json structure of the fingerprint)
 */
export function setTargetFingerprint(aspects: Aspect[]): CommandHandlerRegistration<SetTargetFingerprintParameters> {
    return {
        name: "SetTargetFingerprint",
        description: "set a target fingerprint",
        paramsMaker: SetTargetFingerprintParameters,
        listener: async cli => {
            const fp = {
                user: { id: cli.context.source.slack.user.id },
                ...JSON.parse(cli.parameters.fp),
            };
            await (setFPTarget(cli.context.graphClient))(fp.type, fp.name, fp);
            return askAboutBroadcast(cli, aspects, fp, cli.parameters.msgId);
        },
    };
}

@Parameters()
export class DeleteTargetFingerprintParameters {

    @Parameter({ required: true })
    public type: string;

    @Parameter({ required: true })
    public name: string;

    @Parameter({ required: false, displayable: false })
    public msgId: string;

    @Parameter({ required: false, displayable: true })
    public reason: string;
}

export function deleteTargetFingerprint(sdm: SoftwareDeliveryMachine): CommandHandlerRegistration<DeleteTargetFingerprintParameters> {
    return {
        name: "DeleteTargetFingerprint",
        intent: [
            `delete fingerprint target ${sdm.configuration.name.replace("@", "")}`,
            `deleteFingerprintTarget ${sdm.configuration.name.replace("@", "")}`,
        ],
        description: "remove the team target for a particular fingerprint",
        paramsMaker: DeleteTargetFingerprintParameters,
        listener: async cli => {
            await deleteFPTarget(cli.context.graphClient)(cli.parameters.type, cli.parameters.name);
            await cli.addressChannels(
                slackSuccessMessage(
                    "Remove Target",
                    `Successfully disabled target for policy ${codeLine(toName(cli.parameters.type, cli.parameters.name))}`,
                ),
            );

            const author = _.get(cli.context.source, "slack.user.id") || _.get(cli.context.source, "web.identity.sub");

            const log: PolicyLog = {
                type: cli.parameters.type,
                name: cli.parameters.name,

                manage: {
                    action: ManagePolicyAction.Unset,
                    author,
                    reason: cli.parameters.reason || "Disabled target",
                },
            };
            await sendPolicyLog(log, cli.context);
        },
    };
}

/**
 * Used in other diff handlers to maybe choose to set a new target because one of them has changed
 * (assumed to be a new message - not updating anything)
 *
 * @param ctx
 * @param feature
 * @param fp
 * @param channel
 */
export async function setNewTargetFingerprint(
    ctx: HandlerContext,
    aspect: Aspect,
    fp: FP,
    channel: string): Promise<Vote> {

    // TODO this FP doesn't necessarily hold an FP with a version
    const message = slackQuestionMessage(
        "Fingerprint Target",
        `Shall we update the target of ${displayName(aspect, fp)} to \`${displayValue(aspect, fp)}\` for all projects?`,
        {
            actions: [
                actionableButton<any>(
                    {
                        text: "Set Target",
                    },
                    setTargetFingerprint([aspect]),
                    {
                        fp: JSON.stringify(fp),
                    },
                ),
            ],
            callback_id: "atm-confirm-done",
        },
    );

    await ctx.messageClient.addressChannels(message, channel);

    // I don't want to vote on whether there was a compliance issue here
    return { abstain: true };
}

@Parameters()
export class SelectTargetFingerprintFromCurrentProjectParameters {
    @MappedParameter(MappedParameters.GitHubOwner)
    public owner: string;

    @MappedParameter(MappedParameters.GitHubRepository)
    public repo: string;

    @MappedParameter(MappedParameters.GitHubRepositoryProvider)
    public providerId: string;

    @Parameter({ required: false, description: "pull fingerprints from a branch ref" })
    public branch: string;

    @Parameter({ required: false, displayable: false })
    public msgId: string;
}

function shortenName(s: string): string {
    if (s.length >= 30) {
        return "..." + s.substring(s.length - 27);
    } else {
        return s;
    }
}

/**
 * Bootstrap a fingerprint target by selecting one out of the current set
 */
export function selectTargetFingerprintFromCurrentProject(sdm: SoftwareDeliveryMachine):
    CommandHandlerRegistration<SelectTargetFingerprintFromCurrentProjectParameters> {
    return {
        name: "SelectTargetFingerprintFromCurrentProject",
        intent: [
            `set fingerprint target ${sdm.configuration.name.replace("@", "")}`,
            `setFingerprintTarget ${sdm.configuration.name.replace("@", "")}`,
            `setTargetFingerprint ${sdm.configuration.name.replace("@", "")}`,
        ],
        description: "select a fingerprint in this project to become a target fingerprint",
        paramsMaker: SelectTargetFingerprintFromCurrentProjectParameters,
        listener: async cli => {

            // this has got to be wrong.  ugh
            const branch: string = cli.parameters.branch || "master";

            const fps: GetAllFpsOnSha.Analysis[] = await queryFingerprintsByBranchRef(cli.context.graphClient)(
                cli.parameters.repo,
                cli.parameters.owner,
                branch);

            const message = slackQuestionMessage(
                "Fingerprint Target",
                "Choose one of the current fingerprints:",
                {
                    actions: [
                        menuForCommand(
                            {
                                text: "select fingerprint",
                                options: [
                                    ...fps.map(x => {
                                        return {
                                            value: toName(x.type, x.name),
                                            text: shortenName(x.name),
                                        };
                                    }),
                                ],
                            },
                            setTargetFingerprintFromLatestMaster(sdm, []).name,
                            "fingerprint",
                            {
                                owner: cli.parameters.owner,
                                repo: cli.parameters.repo,
                                branch,
                                providerId: cli.parameters.providerId,
                            },
                        ),
                    ],
                });

            return cli.addressChannels(message);
        },
    };
}
