import {
    EventFired,
    HandlerContext,
    logger,
    SuccessPromise,
} from "@atomist/automation-client";
import { subscription } from "@atomist/automation-client/graph/graphQL";
import { OnEvent } from "@atomist/automation-client/onEvent";
import { NoParameters } from "@atomist/automation-client/SmartParameters";
import { QueryNoCacheOptions } from "@atomist/automation-client/spi/graph/GraphClient";
import {
    buttonForCommand,
    SlackFileMessage,
} from "@atomist/automation-client/spi/message/MessageClient";
import * as impact from "@atomist/clj-editors";
import * as clj from "@atomist/clj-editors";
import { EventHandlerRegistration } from "@atomist/sdm";
import { SlackMessage } from "@atomist/slack-messages";
import * as _ from "lodash";
import {
    GetFingerprintData,
    PushImpactEvent,
} from "../../typings/types";
import {
    ConfirmUpdate,
    IgnoreVersion,
    queryPreferences,
    SetTeamLibrary,
} from "../commands/pushImpactCommandHandlers";

function forFingerprint(s:string): (fp: clj.FP) => boolean {
   return (fp: clj.FP) => {
       logger.info(`check fp ${fp.name}`);
       return (fp.name === s);
   }
}

function getFingerprintDataCallback(ctx: HandlerContext): (sha: string, name: string) => Promise<string> {
    return (sha, name) => {
        return ctx.graphClient.query<GetFingerprintData.Query, GetFingerprintData.Variables>({
            name: "get-fingerprint",
            variables: {
                sha: sha,
                name: name,
            },
            options: QueryNoCacheOptions,
        })
            .then(result => {
                logger.info(`getFingerprintData:  got successful result ${result}`);
                const fingerprints =
                    _.get(result, "Commit[0].fingerprints") as GetFingerprintData.Fingerprints[];
                if (fingerprints) {
                    return fingerprints[0].data as string;
                }
                return "{}";
            })
            .catch((reason) => {
                logger.info(`error getting fingerprint data ${reason}`);
                return "{}";
            });
    };
}

async function renderDiffSnippet(ctx: HandlerContext, diff: impact.Diff) {
    const message: SlackFileMessage = {
        content: clj.renderDiff(diff),
        fileType: "text",
        title: `${diff.owner}/${diff.repo}`,
    };
    return ctx.messageClient.addressChannels(message as SlackMessage, diff.channel);
}

function libraryEditorChoiceMessage(ctx: HandlerContext,diff: impact.Diff): 
    (s: string, action: {library:{ name: string, version: string }, current: string}) => Promise<any> {
    return async (text, action) => {
        const message: SlackMessage = {
            attachments: [
                {
                    text: text,
                    color: "#45B254",
                    fallback: "none",
                    mrkdwn_in: ["text"],
                    actions: [
                        buttonForCommand(
                            { text: "Accept" },
                            ConfirmUpdate.name,
                            {
                                owner: diff.owner,
                                repo: diff.repo,
                                name: action.library.name,
                                version: action.library.version,
                            }),
                        buttonForCommand(
                            { text: "Set as target" },
                            SetTeamLibrary.name,
                            {
                                name: action.library.name,
                                version: action.current,
                            },
                        ),
                        buttonForCommand(
                            { text: "Ignore" },
                            IgnoreVersion.name,
                            {
                                name: action.library.name,
                                version: action.library.version,
                            },
                        ),
                    ],
                },
            ],
        };
        //return ctx.messageClient.send(message, await addressSlackChannelsFromContext(ctx, diff.channel));
        return ctx.messageClient.addressChannels(message, diff.channel);
    };
}

function checkLibraryGoals(ctx: HandlerContext, diff: clj.Diff): void {
    clj.checkLibraryGoals(
        queryPreferences(ctx.graphClient),
        libraryEditorChoiceMessage(ctx, diff),
        diff,
    );
}

const PushImpactHandle: OnEvent<PushImpactEvent.Subscription> =
    (event: EventFired<PushImpactEvent.Subscription>, ctx: HandlerContext) => {
        logger.info("handler PushImpactEvent subscription");
        clj.processPushImpact(
            event,
            getFingerprintDataCallback(ctx),
            [
                {
                    selector: forFingerprint("npm-project-deps"),
                    action: (diff: clj.Diff) => {
                        logger.info(`check for goal diffs here`);
                        checkLibraryGoals(ctx, diff);
                    },
                    diffAction: (diff: clj.Diff) => {
                        renderDiffSnippet(ctx, diff);
                    },
                },
            ],
        );
        return SuccessPromise;
    };

export const PushImpactHandler: EventHandlerRegistration<PushImpactEvent.Subscription, NoParameters> = {
    name: "PushImpactHandler",
    description: "Register push impact handling functions",
    subscription: subscription("push-impact"),
    listener: PushImpactHandle,
};
