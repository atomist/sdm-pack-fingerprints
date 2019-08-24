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

import { Project } from "@atomist/automation-client";
import {
    AutoMerge,
    AutoMergeMethod,
    AutoMergeMode,
} from "@atomist/automation-client/lib/operations/edit/editModes";
import {
    ExtensionPack,
    Fingerprint,
    formatDate,
    Goal,
    metadata,
    PushImpact,
    PushImpactListenerInvocation,
    SoftwareDeliveryMachine,
    TransformPresentation,
} from "@atomist/sdm";
import { toArray } from "@atomist/sdm-core/lib/util/misc/array";
import * as _ from "lodash";
import {
    PublishFingerprints,
    sendFingerprintsToAtomist,
} from "../adhoc/fingerprints";
import { checkFingerprintTarget } from "../checktarget/callbacks";
import {
    ignoreCommand,
    messageMaker,
    MessageMaker,
} from "../checktarget/messageMaker";
import { makeVirtualProjectAware } from "../fingerprints/virtual-project/makeVirtualProjectAware";
import { VirtualProjectFinder } from "../fingerprints/virtual-project/VirtualProjectFinder";
import {
    applyTarget,
    applyTargetBySha,
    ApplyTargetParameters,
    applyTargets,
    broadcastFingerprintMandate,
} from "../handlers/commands/applyFingerprint";
import { broadcastFingerprintNudge } from "../handlers/commands/broadcast";
import { FingerprintMenu } from "../handlers/commands/fingerprints";
import {
    listFingerprint,
    listFingerprints,
} from "../handlers/commands/list";
import {
    listFingerprintTargets,
    listOneFingerprintTarget,
} from "../handlers/commands/showTargets";
import {
    deleteTargetFingerprint,
    selectTargetFingerprintFromCurrentProject,
    setTargetFingerprint,
    setTargetFingerprintFromLatestMaster,
    updateTargetFingerprint,
} from "../handlers/commands/updateTarget";
import {
    Aspect,
    FingerprintDiffHandler,
    FingerprintHandler,
    FP,
    Vote,
} from "./Aspect";
import {
    createFingerprintComputer,
    FingerprintComputer,
    fingerprintRunner,
} from "./runner";

export function forFingerprints(...s: string[]): (fp: FP) => boolean {
    return fp => {
        return s.map(n => (fp.type === n) || (fp.name === n))
            .reduce((acc, v) => acc || v);
    };
}

/**
 * customize the out of the box strategy for monitoring when fingerprints are out
 * of sync with a target.
 *
 */
export interface FingerprintImpactHandlerConfig {
    complianceGoal?: Goal;
    complianceGoalFailMessage?: string;
    transformPresentation: TransformPresentation<ApplyTargetParameters>;
    messageMaker: MessageMaker;
}

/**
 * Setting up a PushImpactHandler to handle different strategies (FingerprintHandlers) involves giving them the opportunity
 * to configure the sdm, and they'll need all of the current active Aspects.
 */
export type RegisterFingerprintImpactHandler = (sdm: SoftwareDeliveryMachine, registrations: Aspect[]) => FingerprintHandler;

export const DefaultTargetDiffHandler: FingerprintDiffHandler =
    async (ctx, diffs, aspect) => {
        const abs = diffs.filter(diff => !diff.from);
        const checked: Vote[] = [];
        for (const diff of _.difference(diffs, abs)) {
            checked.push(await checkFingerprintTarget(
                ctx.context,
                diff,
                aspect,
                async () => diff.targets));
        }
        return _.concat(
            checked,
            abs.map(() => ({abstain: true})));
    };

/**
 * wrap a FingerprintDiffHandler to only check if the shas have changed
 *
 * @param handler the FingerprintDiffHandler to wrap
 */
export function diffOnlyHandler(handler: FingerprintDiffHandler): FingerprintDiffHandler {
    return async (context, diffs, aspect) => {
        const toDiff = diffs.filter(diff => diff.from && diff.to.sha !== diff.from.sha);
        return [
            ...await handler(context, toDiff, aspect),
            ..._.difference(diffs, toDiff).map(() => ({abstain: true})),
        ];
    };
}

/**
 * Options to configure the Fingerprint support
 */
export interface FingerprintOptions {

    /**
     * Optional Fingerprint goal that will get configured.
     * If not provided fingerprints need to be registered manually with the goal.
     * @deprecated use pushImpactGoal instead
     */
    // tslint:disable:deprecation
    fingerprintGoal?: Fingerprint;

    /**
     * Optional PushImpact goal that will get configured
     */
    pushImpactGoal?: PushImpact;

    /**
     * Aspects we are managing
     */
    aspects: Aspect | Aspect[];

    /**
     * Register FingerprintHandler factories to handle fingerprint impacts
     * @deprecated embed handlers in Features
     */
    handlers?: RegisterFingerprintImpactHandler | RegisterFingerprintImpactHandler[];

    transformPresentation?: TransformPresentation<ApplyTargetParameters>;

    /**
     * If provided, all aspects will be automatically be wrapped to use the VirtualProjectFinder.
     */
    virtualProjectFinder?: VirtualProjectFinder;

    /**
     * By default, fingerprints will be sent to Atomist. Set this in local mode etc
     * to route them differently.
     */
    publishFingerprints?: PublishFingerprints;
}

export const DefaultTransformPresentation: TransformPresentation<ApplyTargetParameters> = createPullRequestTransformPresentation();

/**
 * Options to configure the PullRequest creation
 */
export interface PullRequestTransformPresentationOptions {
    branchPrefix?: string;
    title?: string;
    body?: string;
    message?: string;
    autoMerge?: {
        method?: AutoMergeMethod;
        mode?: AutoMergeMode;
    };
}

/**
 * Creates the default TransformPresentation for raising PullRequests
 */
export function createPullRequestTransformPresentation(options: PullRequestTransformPresentationOptions = {})
    : TransformPresentation<ApplyTargetParameters> {
    return (ci, p) => new LazyPullRequest(options, ci.parameters, p);
}

/**
 * Lazy implementation of PullRequest to defer creation of title and body etc to when they
 * are actually needed
 *
 * This allows us to better format the properties of the PullRequest as we have access to the
 * parameters instance.
 */
class LazyPullRequest {

    private readonly fingerprint: string;

    private readonly branchName: string;

    constructor(private readonly options: PullRequestTransformPresentationOptions,
                private readonly parameters: ApplyTargetParameters,
                private readonly project: Project) {

        this.fingerprint = (this.parameters.fingerprint || this.parameters.targetfingerprint || this.parameters.type) as string;
        if (!this.fingerprint) {
            this.fingerprint = this.parameters.fingerprints as string;
            if (!!this.fingerprint) {
                this.fingerprint = this.fingerprint.split(",").map(f => f.trim()).join(", ");
            }
        }
        this.branchName = `${this.options.branchPrefix || "apply-target-fingerprint"}-${formatDate()}`;
    }

    get branch(): string {
        return this.branchName;
    }

    get title(): string {
        return this.options.title || this.parameters.title || `Apply target fingerprint (${this.fingerprint})`;
    }

    get body(): string {
        return `${this.options.body || this.parameters.body || this.title}\n\n[atomist:generated]`;
    }

    get message(): string {
        return (this.options.message || this.parameters.message || this.title) as string;
    }

    get targetBranch(): string {
        return this.project.id.branch;
    }

    get autoMerge(): AutoMerge {
        const autoMerge = _.get(this.options, "autoMerge") || {};
        return {
            method: autoMerge.method || AutoMergeMethod.Squash,
            mode: autoMerge.mode || AutoMergeMode.ApprovedReview,
        };
    }
}

export interface FingerprintExtensionPack extends ExtensionPack {

    /**
     * Function to use to calculate fingerprints on a project
     */
    fingerprintComputer: FingerprintComputer;
}

/**
 * Install and configure the fingerprint support in this SDM
 */
export function fingerprintSupport(options: FingerprintOptions): FingerprintExtensionPack {
    const configuredAspects: Aspect[] = toArray(options.aspects)
        .map(a => makeVirtualProjectAware(a, options.virtualProjectFinder));
    const fingerprintComputer = createFingerprintComputer(configuredAspects, options.virtualProjectFinder);
    return {
        ...metadata(),
        fingerprintComputer,
        configure: (sdm: SoftwareDeliveryMachine) => {
            // const handlerRegistrations: RegisterFingerprintImpactHandler[]
            //     = Array.isArray(options.handlers) ? options.handlers : [options.handlers];
            // const handlers: FingerprintHandler[] = handlerRegistrations.map(h => h(sdm, fingerprints));
            const handlerRegistrations: RegisterFingerprintImpactHandler[] = [];
            const handlers: FingerprintHandler[] = [];

            const runner = fingerprintRunner(
                configuredAspects,
                handlers,
                fingerprintComputer,
                options.publishFingerprints || sendFingerprintsToAtomist,
                {
                    messageMaker,
                    transformPresentation: DefaultTransformPresentation,
                    ...options,
                });

            // tslint:disable:deprecation
            if (!!options.fingerprintGoal) {
                options.fingerprintGoal.with({
                    name: `${options.fingerprintGoal.uniqueName}-fingerprinter`,
                    action: async (i: PushImpactListenerInvocation) => {
                        await runner(i);
                        return [];
                    },
                });
            }
            if (!!options.pushImpactGoal) {
                options.pushImpactGoal.withListener(runner);
            }

            configure(sdm, handlerRegistrations, configuredAspects, options.transformPresentation || DefaultTransformPresentation);
        },
    };
}

function configure(sdm: SoftwareDeliveryMachine,
                   handlers: RegisterFingerprintImpactHandler[],
                   aspects: Aspect[],
                   editModeMaker: TransformPresentation<ApplyTargetParameters>): void {

    sdm.addCommand(listFingerprints(sdm));
    sdm.addCommand(listFingerprint(sdm));

    // set a target given using the entire JSON fingerprint payload in a parameter
    sdm.addCommand(setTargetFingerprint(aspects));
    // set a different target after noticing that a fingerprint is different from current target
    sdm.addCommand(updateTargetFingerprint(sdm, aspects));
    // Bootstrap a fingerprint target by selecting one from current project
    sdm.addCommand(selectTargetFingerprintFromCurrentProject(sdm));
    // Bootstrap a fingerprint target from project by name
    sdm.addCommand(setTargetFingerprintFromLatestMaster(sdm, aspects));
    sdm.addCommand(deleteTargetFingerprint(sdm));

    // standard actionable message embedding ApplyTargetFingerprint
    sdm.addCommand(broadcastFingerprintNudge(aspects));

    sdm.addCommand(ignoreCommand(aspects));

    sdm.addCommand(listFingerprintTargets(sdm));
    sdm.addCommand(listOneFingerprintTarget(sdm));

    sdm.addCommand(FingerprintMenu);

    sdm.addCodeTransformCommand(applyTarget(sdm, aspects, editModeMaker));
    sdm.addCodeTransformCommand(applyTargets(sdm, aspects, editModeMaker));
    sdm.addCodeTransformCommand(applyTargetBySha(sdm, aspects, editModeMaker));

    sdm.addCommand(broadcastFingerprintMandate(sdm, aspects));

}
