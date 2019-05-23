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

import { FP } from "../../fingerprints";

/**
 * An ideal for a fingerprint with a given name.
 */
export interface PossibleIdeal<FPI extends FP> {

    /**
     * Name fo the fingerprint we were asked to provide an ideal for.
     */
    readonly fingerprintName: string;

    /**
     * The ideal fingerprint instance. May be undefined, indicating that
     * this fingerprint should be elminated from projects.
     */
    readonly ideal: FPI;

    /**
     * Reason for the choice
     */
    readonly reason: string;

    /**
     * URL, if any, associated with the ideal fingerprint instance.
     */
    readonly url?: string;
}