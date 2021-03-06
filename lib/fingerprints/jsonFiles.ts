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

import { logger } from "@atomist/automation-client";
import {
    ApplyFingerprint,
    ExtractFingerprint,
    FP,
    sha256,
} from "../..";
import { Aspect } from "../machine/Aspect";

export interface FileFingerprintData {
    filename: string;
    content: string;
}

/**
 * Create fingerprints from JSON files
 * @param {string} filenames
 * @return {ExtractFingerprint}
 */
export function createFileFingerprint(...filenames: string[]): ExtractFingerprint<FileFingerprintData> {
    return createFilesFingerprint(
        "json-file",
        content => JSON.parse(content),
        ...filenames);
}

/**
 * Create fingerprints from JSON files
 * @param type type of the fingerprint
 * @param {(content: string) => any} canonicalize
 * @param {string} filenames
 * @return {ExtractFingerprint}
 */
export function createFilesFingerprint(type: string,
                                       canonicalize: (content: string) => any,
                                       ...filenames: string[]): ExtractFingerprint<FileFingerprintData> {
    return async p => {
        const fps: Array<FP<FileFingerprintData>> = [];
        for (const filename of filenames) {
            const file = await p.getFile(filename);
            if (file) {
                const content = await file.getContent();
                const canonicalized = canonicalize(content);
                fps.push(
                    {
                        type,
                        name: filename,
                        abbreviation: `file-${filename}`,
                        version: "0.0.1",
                        data: {
                            content,
                            filename,
                        },
                        sha: sha256(JSON.stringify(canonicalized)),
                    },
                );
            }
        }
        return fps;
    };
}

export const applyFileFingerprint: ApplyFingerprint<FileFingerprintData> = async (p, papi) => {
    const fp = papi.parameters.fp;
    const file = await p.getFile(fp.data.filename);

    if (file) {
        logger.info("Update content on an existing file");
        await file.setContent(fp.data.content);
    } else {
        logger.info("Creating new file '%s'", fp.data.filename);
        await p.addFile(fp.data.filename, fp.data.content);
    }
    return p;
};

export const JsonFile: Aspect<FileFingerprintData> = {
    displayName: "JSON files",
    name: "json-file",
    extract: createFileFingerprint(
        "tslint.json",
        "tsconfig.json"),
    apply: applyFileFingerprint,
    toDisplayableFingerprint: fp => fp.name,
};

/**
 * Create a aspect that handles the given files
 * @return {Aspect}
 */
export function filesAspect(opts: {
                                type: string,
                                canonicalize: (content: string) => any,
                            } & Pick<Aspect<FileFingerprintData>, "name" | "displayName" |
                                "toDisplayableFingerprintName" | "toDisplayableFingerprint">,
                            ...files: string[]): Aspect<FileFingerprintData> {
    return {
        ...opts,
        extract: createFilesFingerprint(
            opts.type,
            opts.canonicalize,
            ...files),
        apply: applyFileFingerprint,
    };
}
