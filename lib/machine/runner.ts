import { addressEvent, GraphClient, logger, MessageClient, Project, QueryNoCacheOptions } from "@atomist/automation-client";
import { Diff, FP, renderData, Vote } from "@atomist/clj-editors";
import { PushFields, PushImpactListenerInvocation } from "@atomist/sdm";
import { GetAllFpsOnSha, GetPushDetails } from "../typings/types";
import { Feature, FingerprintHandler } from "./Feature";

async function sendCustomEvent(client: MessageClient, push: PushFields.Fragment, fingerprint: any): Promise<void> {
    const customFPEvent = addressEvent("AtomistFingerprint");
    const event: any = {
        ...fingerprint,
        data: JSON.stringify(fingerprint.data),
        commitSha: push.after.sha,
    };

    try {
        await client.send(event, customFPEvent);
    } catch (e) {
        logger.error(`unable to send AtomistFingerprint ${JSON.stringify(fingerprint)}`);
    }
}

interface MissingInfo {
    providerId: string;
    channel: string;
}

async function handleDiffs(
    fp: FP,
    previous: FP,
    info: MissingInfo,
    handlers: FingerprintHandler[],
    i: PushImpactListenerInvocation): Promise<Vote[]> {

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
            to: [],
        },
    };
    let diffVotes: Vote[] = [];
    if (previous && fp.sha !== previous.sha) {
        diffVotes = await Promise.all(
            handlers
                .filter(h => h.diffHandler)
                .filter(h => h.selector(fp))
                .map(h => h.diffHandler(i.context, diff)));
    }
    const currentVotes: Vote[] = await Promise.all(
        handlers
            .filter(h => h.handler)
            .filter(h => h.selector(fp))
            .map(h => h.handler(i.context, diff)));

    return [].concat(
        diffVotes,
        currentVotes,
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
            },
        },
    );
    return results.Commit[0].analysis.reduce<Record<string, FP>>(
        (record: Record<string, FP>, fp: GetAllFpsOnSha.Analysis) => {
            if (fp.name) {
                record[fp.name] = {
                    sha: fp.sha,
                    data: JSON.parse(fp.data),
                    name: fp.name,
                    version: "1.0",
                    abbreviation: "abbrev",
                };
            }
            return record;
        },
        {});
}

async function tallyVotes(vts: Vote[], handlers: FingerprintHandler[], i: PushImpactListenerInvocation, info: MissingInfo): Promise<void> {
    await Promise.all(
        handlers.map(async h => {
            if (h.ballot) {
                await h.ballot(
                    i.context,
                    vts,
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
        },
        ),
    );
}

async function missingInfo(i: PushImpactListenerInvocation): Promise<MissingInfo> {
    const results: GetPushDetails.Query = await i.context.graphClient.query<GetPushDetails.Query, GetPushDetails.Variables>(
        {
            name: "GetPushDetails",
            options: QueryNoCacheOptions,
            variables: {
                id: i.push.id,
            },
        });
    return {
        providerId: results.Push[0].repo.org.scmProvider.providerId,
        channel: results.Push[0].repo.channels[0].name,
    };
}

export type FingerprintRunner = (i: PushImpactListenerInvocation) => Promise<FP[]>;

/**
 * Construct our FingerprintRunner for the current registrations
 */
export function fingerprintRunner(fingerprinters: Feature[], handlers: FingerprintHandler[]): FingerprintRunner {
    return async (i: PushImpactListenerInvocation) => {
        const p: Project = i.project;
        const info: MissingInfo = await missingInfo(i);
        logger.info(`Missing Info:  ${JSON.stringify(info)}`);

        let previous: Record<string, FP> = {};

        if (!!i.push.before) {
            previous = await lastFingerprints(
                i.push.before.sha,
                i.context.graphClient);
        }
        logger.info(`Found ${Object.keys(previous).length} fingerprints`);

        const allFps: FP[] = (await Promise.all(
            fingerprinters.map(
                x => x.extract(p),
            ),
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
                    return acc;
                }
            },
            [],
        );

        logger.debug(renderData(allFps));

        allFps.forEach(
            async fp => {
                await sendCustomEvent(i.context.messageClient, i.push, fp);
            },
        );

        const allVotes: Vote[] = (await Promise.all(
            allFps.map(fp => handleDiffs(fp, previous[fp.name], info, handlers, i)),
        )).reduce<Vote[]>(
            (acc, vts) => acc.concat(vts),
            [],
        );
        logger.debug(`Votes:  ${renderData(allVotes)}`);
        await tallyVotes(allVotes, handlers, i, info);

        return allFps;
    };
}