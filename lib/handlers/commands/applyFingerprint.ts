/*
 * Copyright © 2018 Atomist, Inc.
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
    editModes,
    GitProject,
    guid,
    logger,
    Parameter,
    Parameters,
} from "@atomist/automation-client";
import {
    AutoMergeMethod,
    AutoMergeMode,
} from "@atomist/automation-client/lib/operations/edit/editModes";
import {
    branchAwareCodeTransform,
    CodeTransform,
    CodeTransformRegistration,
    CommandHandlerRegistration,
    RepoTargetingParameters,
    SoftwareDeliveryMachine,
} from "@atomist/sdm";
import { SlackMessage } from "@atomist/slack-messages";
import {
    applyFingerprint,
    FP,
    getFingerprintPreference,
} from "../../../fingerprints/index";
import { queryPreferences } from "../../adhoc/preferences";
import {
    EditModeMaker,
    FingerprintRegistration,
} from "../../machine/FingerprintSupport";
import { footer } from "../../support/util";

@Parameters()
export class ApplyTargetFingerprintParameters {

    @Parameter({ required: false, displayable: false })
    public msgId?: string;

    @Parameter({ required: true })
    public fingerprint: string;
}

async function pushFingerprint( message: (s: string) => Promise<any>, p: GitProject, registrations: FingerprintRegistration[], fp: FP) {

    logger.info(`transform running -- ${fp.name}/${fp.sha} --`);

    for (const registration of registrations) {
        if (registration.apply && registration.selector(fp)) {
            const result: boolean = await registration.apply(p, fp);
            if (!result) {
                await message(`failure applying fingerprint ${fp.name}`);
            }
        }
    }

    await applyFingerprint(p.baseDir, fp);

    return p;
}

function runAllFingerprintAppliers( registrations: FingerprintRegistration[]): CodeTransform<ApplyTargetFingerprintParameters> {
    return async (p, cli) => {

        const message: SlackMessage = {
            attachments: [
                {
                    author_name: "Apply target fingerprint",
                    author_icon: `https://images.atomist.com/rug/check-circle.gif?gif=${guid()}`,
                    text: `Applying target fingerprint \`${cli.parameters.fingerprint}\` to <https://github.com/${
                        p.id.owner}/${p.id.repo}|${p.id.owner}/${p.id.repo}>`,
                    mrkdwn_in: ["text"],
                    color: "#45B254",
                    fallback: "none",
                    footer: footer(),
                },
            ],
        };

        await cli.addressChannels(message);

        return pushFingerprint(
            async (s: string) => cli.addressChannels(s),
            (p as GitProject),
            registrations,
            await getFingerprintPreference(
                queryPreferences(cli.context.graphClient),
                cli.parameters.fingerprint));
    };
}
function runEveryFingerprintApplication( registrations: FingerprintRegistration[]): CodeTransform<ApplyTargetFingerprintsParameters> {
    return async (p, cli) => {

        const message: SlackMessage = {
            attachments: [
                {
                    author_name: "Apply target fingerprints",
                    author_icon: `https://images.atomist.com/rug/check-circle.gif?gif=${guid()}`,
                    text: `Applying target fingerprints \`${cli.parameters.fingerprints}\` to <https://github.com/${
                        p.id.owner}/${p.id.repo}|${p.id.owner}/${p.id.repo}>`,
                    mrkdwn_in: ["text"],
                    color: "#45B254",
                    fallback: "none",
                    footer: footer(),
                },
            ],
        };

        await cli.addressChannels(message);

        await Promise.all(
            cli.parameters.fingerprints.split(",").map(
                async fpName => {
                    return pushFingerprint(
                        async (s: string) => cli.addressChannels(s),
                        (p as GitProject),
                        registrations,
                        await getFingerprintPreference(
                            queryPreferences(cli.context.graphClient),
                            fpName));
                },
            ),
        );
        return p;
    };
}

export let ApplyTargetFingerprint: CodeTransformRegistration<ApplyTargetFingerprintParameters>;

export function applyTargetFingerprint(
    registrations: FingerprintRegistration[],
    presentation: EditModeMaker ): CodeTransformRegistration<ApplyTargetFingerprintParameters> {
    ApplyTargetFingerprint = {
        name: "ApplyTargetFingerprint",
        intent: "applyFingerprint",
        description: "choose to raise a PR on the current project to apply a target fingerprint",
        paramsMaker: ApplyTargetFingerprintParameters,
        transformPresentation: presentation,
        transform: runAllFingerprintAppliers(registrations),
        autoSubmit: true,
    };
    return ApplyTargetFingerprint;
}

export interface ApplyTargetFingerprintsParameters {
    msgId?: string;
    fingerprints: string;
}

export function applyTargetFingerprints(
    registrations: FingerprintRegistration[],
    presentation: EditModeMaker,
    ): CodeTransformRegistration<ApplyTargetFingerprintsParameters> {

    return {
        name: "ApplyAllFingerprints",
        description: "apply a bunch of fingerprints",
        transform: runEveryFingerprintApplication(registrations),
        transformPresentation: (ci, p) => {
            return new editModes.PullRequest(
                `apply-target-fingerprints-${Date.now()}`,
                `Apply fingerprints ${ci.parameters.fingerprints} to project`,
                "generated by Atomist",
                undefined,
                "master",
                {
                    method: AutoMergeMethod.Squash,
                    mode: AutoMergeMode.SuccessfulCheck,
                });
        },
        parameters: {
            msgId: {required: false, displayable: false},
            fingerprints: {required: true, displayable: false},
        },
        autoSubmit: true,
    };
}

export let FingerprintApplicationCommandRegistration: CommandHandlerRegistration<RepoTargetingParameters>;
export let ApplyAllFingerprintsCommandRegistration: CommandHandlerRegistration<RepoTargetingParameters>;

export function compileApplyFingerprintCommand(
    registrations: FingerprintRegistration[], presentation: EditModeMaker, sdm: SoftwareDeliveryMachine) {

    FingerprintApplicationCommandRegistration = branchAwareCodeTransform(applyTargetFingerprint(registrations, presentation), sdm);
    return FingerprintApplicationCommandRegistration;
}

export function compileApplyAllFingerprintsCommand(
    registrations: FingerprintRegistration[], presentation: EditModeMaker, sdm: SoftwareDeliveryMachine) {

    ApplyAllFingerprintsCommandRegistration = branchAwareCodeTransform(applyTargetFingerprints(registrations, presentation), sdm);
    return ApplyAllFingerprintsCommandRegistration;
}
