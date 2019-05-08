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
    addressEvent,
    editModes,
    GitProject,
    GraphQL,
    HandlerContext,
    logger,
    MessageClient,
    Project,
    GraphClient,
    QueryNoCacheOptions,
} from "@atomist/automation-client";
import {
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
import _ = require("lodash");
import {
    Diff,
    FP,
    renderData,
    Vote,
} from "../../fingerprints/index";
import {
    checkFingerprintTarget,
    votes,
} from "../checktarget/callbacks";
import {
    GitCoordinate,
    IgnoreCommandRegistration,
    MessageMaker,
} from "../checktarget/messageMaker";
import { getNpmDepFingerprint } from "../fingerprints/npmDeps";
import {
    applyTarget,
    ApplyTargetParameters,
    applyTargets,
    broadcastFingerprintMandate,
} from "../handlers/commands/applyFingerprint";
import { BroadcastFingerprintNudge } from "../handlers/commands/broadcast";
import {
    FingerprintEverything,
} from "../handlers/commands/fingerprint";
import {
    ListFingerprint,
    ListFingerprints,
} from "../handlers/commands/list";
import {
    listFingerprintTargets,
    listOneFingerprintTarget,
} from "../handlers/commands/showTargets";
import {
    DeleteTargetFingerprint,
    SelectTargetFingerprintFromCurrentProject,
    setNewTargetFingerprint,
    SetTargetFingerprint,
    SetTargetFingerprintFromLatestMaster,
    UpdateTargetFingerprint,
} from "../handlers/commands/updateTarget";
import { PushFields } from "@atomist/sdm-core/lib/typings/types";
import { GetAllFpsOnSha, GetPushDetails } from "../typings/types";

export function forFingerprints(...s: string[]): (fp: FP) => boolean {
    return fp => {
        const m = s.map((n: string) => (fp.name === n))
            .reduce((acc, v) => acc || v);
        return m;
    };
}

/**
 * Wrap a FingerprintRunner in a PushImpactListener so we can embed this in an  SDMGoal
 *
 * @param fingerprinter
 */
export function runFingerprints(fingerprinter: FingerprintRunner): PushImpactListener<FingerprinterResult> {
    return async (i: PushImpactListenerInvocation) => {
        return fingerprinter(i);
    };
}

type FingerprintRunner = (i: PushImpactListenerInvocation) => Promise<FP[]>;
export type ExtractFingerprint = (p: GitProject) => Promise<FP | FP[]>;
export type ApplyFingerprint = (p: GitProject, fp: FP) => Promise<boolean>;

export interface DiffSummary {
    title: string;
    description: string;
}

export type DiffSummaryFingerprint = (diff: Diff, target: FP) => DiffSummary;

/**
 * different strategies can be used to handle PushImpactEventHandlers.
 */
export interface FingerprintHandler {
    selector: (name: FP) => boolean;
    diffHandler?: (context: HandlerContext, diff: Diff) => Promise<Vote>;
    handler?: (context: HandlerContext, diff: Diff) => Promise<Vote>;
    ballot?: (context: HandlerContext, votes: Vote[], coord: GitCoordinate, channel: string) => Promise<any>;
}

/**
 * permits customization of EditModes in the FingerprintImpactHandlerConfig
 */
export type EditModeMaker = (cli: CommandListenerInvocation<ApplyTargetParameters>, project?: Project) => editModes.EditMode;

/**
 * customize the out of the box strategy for monitoring when fingerprints are out
 * of sync with a target.
 */
export interface FingerprintImpactHandlerConfig {
    complianceGoal?: Goal;
    complianceGoalFailMessage?: string;
    transformPresentation: EditModeMaker;
    messageMaker: MessageMaker;
}

/**
 * each new class of Fingerprints must implement this interface and pass the
 */
export interface FingerprintRegistration {
    selector: (name: FP) => boolean;
    extract: ExtractFingerprint;
    apply?: ApplyFingerprint;
    summary?: DiffSummaryFingerprint;
}

/**
 * Setting up a PushImpactHandler to handle different strategies (FingerprintHandlers) involves giving them the opportunity
 * to configure the sdm, and they'll need all of the current active FingerprintRegistrations.
 */
export type RegisterFingerprintImpactHandler = (sdm: SoftwareDeliveryMachine, registrations: FingerprintRegistration[]) => FingerprintHandler;

/**
 * convenient function to register a create a FingerprintRegistration
 *
 * @param name name of the new Fingerprint
 * @param extract function to extract the Fingerprint from a cloned code base
 * @param apply function to apply an external Fingerprint to a cloned code base
 */
export function register(name: string, extract: ExtractFingerprint, apply?: ApplyFingerprint): FingerprintRegistration {
    return {
        selector: (fp: FP) => (fp.name === name),
        extract,
        apply,
    };
}

function checkScope(fp: FP, registrations: FingerprintRegistration[]): boolean {
    const inScope: boolean = _.some(registrations, reg => reg.selector(fp));
    return inScope;
}

/**
 * This configures the registration function for the "target fingerprint" FingerprintHandler.  It's an important one
 * because it's the one that generates messages when fingerprints don't line up with their "target" values.  It does
 * nothing when there's no target set for a workspace.
 *
 * @param config
 */
export function fingerprintImpactHandler(config: FingerprintImpactHandlerConfig): RegisterFingerprintImpactHandler {
    return (sdm: SoftwareDeliveryMachine, registrations: FingerprintRegistration[]) => {
        // set goal Fingerprints
        //   - first can be added as an option when difference is noticed (uses our api to update the fingerprint)
        //   - second is a default intent
        //   - TODO:  third is just for resetting
        //   - both use askAboutBroadcast to generate an actionable message pointing at BroadcastFingerprintNudge

        // set a target given using the entire JSON fingerprint payload in a parameter
        sdm.addCommand(SetTargetFingerprint);
        // set a different target after noticing that a fingerprint is different from current target
        sdm.addCommand(UpdateTargetFingerprint);
        // Bootstrap a fingerprint target by selecting one from current project
        sdm.addCommand(SelectTargetFingerprintFromCurrentProject);
        // Bootstrap a fingerprint target from project by name
        sdm.addCommand(SetTargetFingerprintFromLatestMaster);
        sdm.addCommand(DeleteTargetFingerprint);

        // standard actionable message embedding ApplyTargetFingerprint
        sdm.addCommand(BroadcastFingerprintNudge);

        sdm.addCommand(IgnoreCommandRegistration);

        sdm.addCommand(listFingerprintTargets(sdm));
        sdm.addCommand(listOneFingerprintTarget(sdm));

        sdm.addCodeTransformCommand(applyTarget(sdm, registrations, config.transformPresentation));
        sdm.addCodeTransformCommand(applyTargets(sdm, registrations, config.transformPresentation));

        sdm.addCommand(broadcastFingerprintMandate(sdm, registrations));

        return {
            selector: fp => checkScope(fp, registrations),
            handler: async (ctx, diff) => {
                const v: Vote = await checkFingerprintTarget(ctx, diff, config, registrations);
                return v;
            },
            ballot: votes(config),
        };
    };
}

/**
 * This creates the registration function for a handler that notices that a project.clj file version
 * has been updated.
 */
export function checkCljCoordinatesImpactHandler(): RegisterFingerprintImpactHandler {
    return (sdm: SoftwareDeliveryMachine) => {

        return {
            selector: forFingerprints("clojure-project-coordinates"),
            diffHandler: (ctx, diff) => {
                return setNewTargetFingerprint(
                    ctx,
                    getNpmDepFingerprint(diff.to.data.name, diff.to.data.version),
                    diff.channel);
            },
        };
    };
}

/**
 * This creates the registration function for a handler that notices that a package.json version
 * has been updated.
 */
export function checkNpmCoordinatesImpactHandler(): RegisterFingerprintImpactHandler {
    return (sdm: SoftwareDeliveryMachine) => {

        return {
            selector: forFingerprints("npm-project-coordinates"),
            diffHandler: (ctx, diff) => {
                return setNewTargetFingerprint(
                    ctx,
                    getNpmDepFingerprint(diff.to.data.name, diff.to.data.version),
                    diff.channel);
            },
        };
    };
}

/**
 * Utility for creating a registration function for a handler that will just invoke the supplied callback
 * if one of the suppled fingerprints changes
 *
 * @param handler callback
 * @param names set of fingerprint names that should trigger the callback
 */
export function simpleImpactHandler(
    handler: (context: HandlerContext, diff: Diff) => Promise<any>,
    ...names: string[]): RegisterFingerprintImpactHandler {
    return (sdm: SoftwareDeliveryMachine) => {
        return {
            selector: forFingerprints(...names),
            diffHandler: handler,
        };
    };
}

function sendCustomEvent(client: MessageClient, push: PushFields.Fragment, fingerprint: any): void {

    const customFPEvent = addressEvent("AtomistFingerprint");

    const event: any = {
        ...fingerprint,
        branch: push.branch,
        commit: push.after.sha,
    }

    try {
        client.send(event, customFPEvent);
    } catch (e) {
        logger.error(`unable to send AtomistFingerprint ${JSON.stringify(fingerprint)}`);
    }
}

interface MissingInfo { providerId: string, channel: string };

async function handleDiffs(fp: FP, previous: FP, info: MissingInfo, handlers: FingerprintHandler[], i: PushImpactListenerInvocation): Promise<Vote[]> {
    const diff: Diff = {
        ...info,
        from: previous,
        to: fp,
        branch: i.push.branch,
        owner: i.push.repo.owner,
        repo: i.push.repo.name,
        sha: i.push.after.sha,
        data: {
            from: [],
            to: []
        }
    };
    let diffVotes: Vote[] = new Array<Vote>();
    if (previous && fp.sha != previous.sha) {
        diffVotes = await Promise.all(
            handlers
                .filter(h => h.diffHandler)
                .filter(h => h.selector(fp))
                .map(h => h.diffHandler(i.context, diff)));
    }
    const votes: Vote[] = await Promise.all(
        handlers
            .filter(h => h.handler)
            .filter(h => h.selector(fp))
            .map(h => h.handler(i.context, diff)));

    return [].concat(
        diffVotes,
        votes
    );
}

async function lastFingerprints(sha: string, graphClient: GraphClient): Promise<Record<string, FP>> {
    // TODO what about empty queries, and missing fingerprints on previous commit
    const results: GetAllFpsOnSha.Query = await graphClient.query<GetAllFpsOnSha.Query, GetAllFpsOnSha.Variables>(
        {
            name: "GetAllFpsOnSha",
            options: QueryNoCacheOptions,
            variables: {
                sha,
            }
        }
    );
    return results.Commit[0].pushes[0].fingerprints.reduce(
        (record: Record<string, FP>, fp: GetAllFpsOnSha.Fingerprints) => {
            if (fp.name) {
                record[fp.name] = {
                    sha: fp.sha,
                    data: fp.data,
                    name: fp.name,
                    version: "1.0",
                    abbreviation: "abbrev"
                };
            }
            return record;
        },
        {});
}

async function tallyVotes(votes: Vote[], handlers: FingerprintHandler[], i: PushImpactListenerInvocation, info: MissingInfo) {
    await Promise.all(
        handlers.map(async h => {
            if (h.ballot) {
                await h.ballot(
                    i.context,
                    votes,
                    {
                        owner: i.push.repo.owner,
                        repo: i.push.repo.name,
                        sha: i.push.after.sha,
                        providerId: info.providerId,
                        branch: i.push.branch,
                    },
                    info.channel,
                );
            }
        }
        )
    );
}

async function missingInfo(i: PushImpactListenerInvocation): Promise<MissingInfo> {
    const results: GetPushDetails.Query = await i.context.graphClient.query<GetPushDetails.Query, GetPushDetails.Variables>(
        {
            name: "GetPushDetails",
            options: QueryNoCacheOptions,
            variables: {
                id: i.push.id,
            }
        });
    return {
        providerId: results.Push[0].repo.org.scmProvider.providerId,
        channel: results.Push[0].repo.channels[0].name
    };
}

/**
 * Construct our FingerprintRunner for the current registrations
 *
 * @param fingerprinters
 */
export function fingerprintRunner(fingerprinters: FingerprintRegistration[], handlers: FingerprintHandler[]): FingerprintRunner {
    return async (i: PushImpactListenerInvocation) => {

        const p: GitProject = i.project;

        const info: MissingInfo = await missingInfo(i);
        logger.info(`Missing Info:  ${JSON.stringify(info)}`);

        const previous: Record<string, FP> = await lastFingerprints(
            i.push.before.sha,
            i.context.graphClient);
        logger.info(`Found ${Object.keys(previous).length} fingerprints`);

        const fps: FP[] = (await Promise.all(
            fingerprinters.map(
                x => x.extract(p)
            )
        )).reduce<FP[]>(
            (acc, fps) => {
                if (fps && !(fps instanceof Array)) {
                    acc.push(fps);
                    return acc;
                } else if (fps) {
                    // TODO does concat return the larger array?
                    return acc.concat(fps);
                } else {
                    logger.warn(`extractor returned something weird ${JSON.stringify(fps)}`);
                    return acc
                }
            },
            []
        )

        logger.debug(renderData(fps));

        fps.forEach(
            fp => {
                sendCustomEvent(i.context.messageClient, i.push, fp);
            }
        );

        const votes: Vote[] = (await Promise.all(
            fps.map(fp => handleDiffs(fp, previous[fp.name], info, handlers, i))
        )).reduce<Vote[]>(
            (acc, votes) => { return acc.concat(votes); },
            []
        );
        logger.debug(`Votes:  ${renderData(votes)}`)
        tallyVotes(votes, handlers, i, info);

        return fps;
    };
}

/**
 * Options to configure the Fingerprint support
 */
export interface FingerprintOptions {
    /**
     * Optional Fingerprint goal that will get configured.
     * If not provided fingerprints need to be registered manually with the goal.
     */
    fingerprintGoal?: Fingerprint;

    /**
     * Registrations for desired fingerprints
     */
    fingerprints: FingerprintRegistration | FingerprintRegistration[];

    /**
     * Register FingerprintHandler factories to handle fingerprint impacts
     */
    handlers: RegisterFingerprintImpactHandler | RegisterFingerprintImpactHandler[];
}

/**
 * Install and configure the fingerprint support in this SDM
 */
export function fingerprintSupport(options: FingerprintOptions): ExtensionPack {
    return {
        ...metadata(),
        configure: (sdm: SoftwareDeliveryMachine) => {

            const fingerprints = Array.isArray(options.fingerprints) ? options.fingerprints : [options.fingerprints];
            const handlers = Array.isArray(options.handlers) ? options.handlers : [options.handlers];

            if (!!options.fingerprintGoal) {
                options.fingerprintGoal.with({
                    name: `${options.fingerprintGoal.uniqueName}-fingerprinter`,
                    action: runFingerprints(fingerprintRunner(fingerprints, handlers.map(h => h(sdm, fingerprints)))),
                });
            }

            configure(sdm, handlers, fingerprints);
        },
    };
}

function configure(sdm: SoftwareDeliveryMachine,
    handlers: RegisterFingerprintImpactHandler[],
    fpRegistraitons: FingerprintRegistration[]): void {

    sdm.addIngester(GraphQL.ingester("AtomistFingerprint"));

    sdm.addCommand(ListFingerprints);
    sdm.addCommand(ListFingerprint);
    sdm.addCommand(FingerprintEverything);
}
