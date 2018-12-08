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
    HandlerContext,
    logger,
} from "@atomist/automation-client";
import {
    actionableButton,
    CommandListenerInvocation,
    ExtensionPack,
    Fingerprint,
    FingerprinterResult,
    Goal,
    metadata,
    PushImpactListener,
    PushImpactListenerInvocation,
    SoftwareDeliveryMachine,
} from "@atomist/sdm";
import { checkFingerprintTargets, depsFingerprints, logbackFingerprints } from "../..";
import * as fingerprints from "../../fingerprints/index";
import {
    applyTargetFingerprint,
    ApplyTargetFingerprintParameters,
} from "../fingerprints/applyFingerprint";
import { BroadcastFingerprintNudge } from "../fingerprints/broadcast";
import {
    MessageIdMaker,
    MessageMaker,
} from "../fingerprints/impact";
import { ListFingerprints } from "../fingerprints/list";
import {
    DeleteTargetFingerprint,
    SetTargetFingerprintFromLatestMaster,
    UpdateTargetFingerprint,
} from "../fingerprints/updateTarget";
import { BroadcastNudge } from "../handlers/commands/broadcast";
import { ConfirmUpdate } from "../handlers/commands/confirmUpdate";
import { IgnoreVersion } from "../handlers/commands/ignoreVersion";
import {
    ChooseTeamLibrary,
    SetTeamLibrary,
} from "../handlers/commands/setLibraryGoal";
import {
    ClearLibraryTargets,
    DumpLibraryPreferences,
    ShowGoals,
    ShowTargets,
} from "../handlers/commands/showTargets";
import { UseLatest } from "../handlers/commands/useLatest";
import { PullRequestImpactHandlerRegistration } from "../handlers/events/prImpactHandler";
import {
    checkLibraryGoals,
    forFingerprints,
    pushImpactHandler,
} from "../handlers/events/pushImpactHandler";
import { footer } from "../support/util";

/**
 * run fingerprints on every Push
 * send them in batch
 *
 * FingerprinterResult should be an array of Fingerprint maps
 *
 * @param i
 */
function runFingerprints(fingerprinter: FingerprintRunner): PushImpactListener<FingerprinterResult> {
    return async (i: PushImpactListenerInvocation) => {
        return fingerprinter(i.project);
    };
}

export type FingerprintRunner = (p: GitProject) => Promise<fingerprints.FP[]>;
export type ExtractFingerprint = (p: GitProject) => Promise<fingerprints.FP>;
export type ApplyFingerprint = (p: GitProject, fp: fingerprints.FP) => Promise<boolean>;

export interface FingerprintHandler {
    selector: (name: fingerprints.FP) => boolean;
    diffHandler?: (context: HandlerContext, diff: fingerprints.Diff) => Promise<any>;
    handler?: (context: HandlerContext, diff: fingerprints.Diff) => Promise<any>;
}

export type RegisterFingerprintHandler = (sdm: SoftwareDeliveryMachine, registrations: FingerprintRegistration[]) => FingerprintHandler;

export type editModeMaker = (cli: CommandListenerInvocation<ApplyTargetFingerprintParameters>) => editModes.EditMode;

export interface FingerprintHandlerConfig {
    complianceGoal?: Goal;
    complianceGoalFailMessage?: string;
    transformPresentation: editModeMaker;
    messageMaker: MessageMaker;
    messageIdMaker?: MessageIdMaker;
}

export interface FingerprintRegistration {
    selector: (name: fingerprints.FP) => boolean;
    extract: ExtractFingerprint;
    apply?: ApplyFingerprint;
}

export function register(name: string, extract: ExtractFingerprint, apply?: ApplyFingerprint): FingerprintRegistration {
    return {
        selector: (fp: fingerprints.FP) => (fp.name === name),
        extract,
        apply,
    };
}

// default implementation
export const messageMaker: MessageMaker = params => {
    return {
        attachments: [
            {
                text: params.text,
                color: "#45B254",
                fallback: "Fingerprint Update",
                mrkdwn_in: ["text"],
                actions: [
                    actionableButton(
                        { text: "Update project" },
                        params.editProject,
                        {
                            msgId: params.msgId,
                            owner: params.diff.owner,
                            repo: params.diff.repo,
                            fingerprint: params.fingerprint.name,
                        }),
                    actionableButton(
                        { text: "Set New Target" },
                        params.mutateTarget,
                        {
                            msgId: params.msgId,
                            name: params.fingerprint.name,
                            sha: params.fingerprint.sha,
                        },
                    ),
                ],
                footer: footer(),
            },
        ],
    };
};

export function fingerprintImpactHandler( config: FingerprintHandlerConfig ): RegisterFingerprintHandler {
    return  (sdm: SoftwareDeliveryMachine, registrations: FingerprintRegistration[]) => {
        // set goal Fingerprints
        //   - first can be added as an option when difference is noticed (uses our api to update the fingerprint)
        //   - second is a default intent
        //   - TODO:  third is just for resetting
        //   - both use askAboutBroadcast to generate an actionable message pointing at BroadcastFingerprintNudge
        sdm.addCommand(UpdateTargetFingerprint);
        sdm.addCommand(SetTargetFingerprintFromLatestMaster);
        sdm.addCommand(DeleteTargetFingerprint);

        // standard actionable message embedding ApplyTargetFingerprint
        sdm.addCommand(BroadcastFingerprintNudge);

        // this is the fingerprint editor
        sdm.addCodeTransformCommand(applyTargetFingerprint(registrations, config.transformPresentation));

        sdm.addCommand(ListFingerprints);

        return {
            selector: fp => true,
            handler: async (ctx, diff) => {
                return checkFingerprintTargets(ctx, diff, config);
            },
        };
    };
}

export function checkLibraryImpactHandler(): RegisterFingerprintHandler {
    return (sdm: SoftwareDeliveryMachine) => {
        return {
            selector: forFingerprints(
                "clojure-project-deps",
                "maven-project-deps",
                "npm-project-deps"),
            handler: async (ctx, diff) => {
                return checkLibraryGoals(ctx, diff);
            },
        };
    };
}

export function simpleImpactHandler(
    handler: (context: HandlerContext, diff: fingerprints.Diff) => Promise<any>,
    ...names: string[]): RegisterFingerprintHandler {
    return (sdm: SoftwareDeliveryMachine) => {
        return {
            selector: forFingerprints(...names),
            diffHandler: handler,
        };
    };
}

// TODO error handling goes here
function fingerprintRunner(fingerprinters: FingerprintRegistration[]): FingerprintRunner {
    return async (p: GitProject) => {

        const fps = [].concat(
            await depsFingerprints(p.baseDir),
        ).concat(
            await logbackFingerprints(p.baseDir),
        );

        for (const fingerprinter of fingerprinters) {
            try {
                const fp = await fingerprinter.extract(p);
                if (fp) {
                    fps.push(fp);
                }
            } catch (e) {
                logger.error(e);
            }
        }

        logger.info(fingerprints.renderData(fps));
        return fps;
    };
}

/**
 *
 *
 * @param goal use this Goal to run Fingeprints
 * @param fingerprinter callback to create a Fingerprints for the after Commmit of each Push
 * @param fingerprintPusher
 * @param handlers
 */
export function fingerprintSupport(
    goal: Fingerprint,
    fingerprinters: FingerprintRegistration[],
    ...handlers: RegisterFingerprintHandler[]): ExtensionPack {

    goal.with({
        name: "fingerprinter",
        action: runFingerprints(fingerprintRunner(fingerprinters)),
    });

    return {
        ...metadata(),
        configure: (sdm: SoftwareDeliveryMachine) => {
            configure( sdm, handlers, fingerprinters);
        },
    };
}

function configure(sdm: SoftwareDeliveryMachine, handlers: RegisterFingerprintHandler[], fpRegistraitons: FingerprintRegistration[]): void {

    // Fired on every Push after Fingerprints are uploaded
    sdm.addEvent(pushImpactHandler(handlers.map(h => h(sdm, fpRegistraitons))));

    // Fired on each PR after Fingerprints are uploaded
    sdm.addEvent(PullRequestImpactHandlerRegistration);

    // Deprecated
    sdm.addCommand(IgnoreVersion);
    sdm.addCodeTransformCommand(ConfirmUpdate);
    sdm.addCommand(SetTeamLibrary);
    sdm.addCodeInspectionCommand(ShowGoals);
    sdm.addCommand(ChooseTeamLibrary);
    sdm.addCommand(ClearLibraryTargets);
    sdm.addCommand(BroadcastNudge);
    sdm.addCommand(ShowTargets);
    sdm.addCommand(DumpLibraryPreferences);
    sdm.addCommand(UseLatest);
}
