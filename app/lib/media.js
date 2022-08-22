/* eslint-disable max-classes-per-file */

const transformer = require('enketo-transformer');
const path = require('path');
const instanceModel = require('../models/instance-model');
const surveyModel = require('../models/survey-model');
const userModel = require('../models/user-model');
const communicator = require('./communicator');
const error = require('./custom-error');

/**
 * @typedef ExpiringCacheMapOptions
 * @property {number} expirationMS
 */

/**
 * @template Key
 * @template Value
 * @extends Map<Key, Value>
 */
class ExpiringCacheMap extends Map {
    /**
     * @param {ExpiringCacheMapOptions} options
     * @param {readonly (readonly [Key, Value])[] | null} [entries]
     */
    constructor(options, entries) {
        super(entries);

        /** @private */
        this.expirationMS = options.expirationMS;

        /**
         * @private
         * @type {Map<Key, number>}
         */
        this.invalidationTimers = new Map();
    }

    /**
     * One of the hard problems...
     *
     * @private
     * @param {Key} key
     */
    resetExpiation(key) {
        let timer = this.invalidationTimers.get(key);

        if (timer != null) {
            clearTimeout(timer);
        }

        timer = setTimeout(() => {
            super.delete(key);
            this.invalidationTimers.delete(key);
        }, this.expirationMS);

        this.invalidationTimers.set(key, timer);
    }

    /**
     * @param {Key} key
     */
    get(key) {
        const result = super.get(key);

        this.resetExpiation(key);

        return result;
    }

    /**
     * @param {Key} key
     */
    has(key) {
        const result = super.has(key);

        this.resetExpiation(key);

        return result;
    }

    /**
     * @param {Key} key
     * @param {Value} value
     */
    set(key, value) {
        super.set(key, value);
        this.resetExpiation(key);
    }
}

// It's a URL mapping. How long could you need it? Ten minutes?
const MEDIA_MAP_CACHE_ENTRY_EXPIRATION_MS = 1000 * 60 * 10;

const mediaMapCache = new ExpiringCacheMap({
    expirationMS: MEDIA_MAP_CACHE_ENTRY_EXPIRATION_MS,
});

/**
 * @param {string | null} deviceId
 * @param {string}
 */
const getCacheKey = (deviceId, mediaURL) => `${deviceId}:${mediaURL}`;

/** @enum {typeof ResourceType[keyof typeof ResourceType]} */
const ResourceType = /** @type {const} */ ({
    MANIFEST: '0',
    INSTANCE: '1',
});

/**
 * @typedef MediaURLSegments
 * @property {string} resourceType
 * @property {string} resourceId
 * @property {string} fileName
 */

/**
 * @param {string} requestPath
 * @return {MediaURLSegments | void}
 */
const matchMediaURLSegments = (requestPath) => {
    // Note: express `request.url` begins with the path attached to the
    // *route*, rather than the full request path.
    const matches = requestPath.match(/^\/get\/([01])\/([^/]+)\/(.+$)/);

    if (matches != null) {
        const [, resourceType, resourceId, fileName] = matches;

        return {
            resourceType,
            resourceId,
            fileName,
        };
    }
};

/**
 * @typedef MediaURLOptions
 * @property {string} basePath
 * @property {string} fileName
 * @property {string} resourceType
 * @property {string} resourceId
 */

/**
 * @param {MediaURLOptions} options
 */
const createMediaURL = (options) => {
    const { basePath, fileName, resourceType, resourceId } = options;

    const mediaPath = path.join(
        '/',
        basePath,
        'media',
        'get',
        resourceType,
        resourceId,
        fileName
    );

    return transformer.escapeURLPath(mediaPath);
};

/**
 * @param {string} requestPath
 * @param {MediaURLSegments} [options]
 */
const getMediaURL = (requestPath) =>
    createMediaURL(matchMediaURLSegments(requestPath));

const markupEntities = {
    '<': '&lt;',
    '>': '&gt;',
    '&': '&amp;',
    '"': '&quot;',
};

/**
 * @param {string} fileName
 */
const escapeFileName = (fileName) =>
    transformer
        .escapeURLPath(fileName)
        .replace(/[\\/]/g, (character) => encodeURIComponent(character))
        .replace(/[&<>"]/g, (character) => markupEntities[character]);

/**
 * @param {string}
 * @param {ManifestItem[] | Record<string, string>} media
 * @param {HostURLOptions} options
 */
const cacheMediaURLs = (resourceId, media, options) => {
    const { basePath, deviceId } = options;
    const resourceType = Array.isArray(media)
        ? ResourceType.MANIFEST
        : ResourceType.INSTANCE;
    const mediaEntries =
        resourceType === ResourceType.MANIFEST
            ? media.map(({ filename, downloadUrl }) => [filename, downloadUrl])
            : Object.entries(media);

    /** @type {Record<string, string>} */
    const result = {};

    mediaEntries.forEach(([fileName, hostURL]) => {
        const mediaURL = createMediaURL({
            basePath,
            fileName,
            resourceType,
            resourceId,
        });

        const cacheKey = getCacheKey(deviceId, mediaURL);

        mediaMapCache.set(cacheKey, hostURL);
        result[escapeFileName(fileName)] = mediaURL;
    });

    return result;
};

/**
 * @typedef {import('../models/survey-model').SurveyObject} Survey
 */

/**
 * A simplified version of the minimal logic performed in
 * transformation-controller.js, for cached forms. Currently redundantly
 * reimplemented, because:
 *
 * - transformation-controller doesn't and currently _can't_ export it
 * - this omits some logic which is performed when caching forms, but
 *   it's intended purpose is to support retrieving a manifest for an
 *   already-cached form.
 *
 * In the future we can investigate whether this logic can be reused
 * there, eliminating the redundancy.
 *
 * @param {string} enketoId
 * @param {HostURLOptions} options
 * @return {Promise<Survey>}
 */
const getSurveyInfo = async (enketoId, options) => {
    const { auth: credentials, cookie } = options;
    const { openRosaServer, openRosaId } = await surveyModel.get(enketoId);

    return communicator.getXFormInfo({
        openRosaServer,
        openRosaId,
        cookie,
        credentials,
    });
};

/**
 * @param {string} enketoId
 * @param {HostURLOptions} options
 * @return {Promise<Survey>}
 */
const getManifest = async (enketoId, options) => {
    const surveyInfo = await getSurveyInfo(enketoId, options);
    const { manifest } = await communicator.getManifest(surveyInfo);

    return manifest;
};

const getInstanceAttachments = async (instanceId) => {
    const { instanceAttachments } = await instanceModel.get({ instanceId });

    return instanceAttachments;
};

/**
 * @param {ResourceType} resourceType
 * @param {string} resourceId
 * @param {HostURLOptions} options
 */
const rebuildMediaURLCache = async (resourceType, resourceId, options) => {
    mediaMapCache.expirationMS = 1000 * 60 * 10;

    let media;

    if (resourceType === ResourceType.MANIFEST) {
        media = await getManifest(resourceId, options);
    } else {
        media = await getInstanceAttachments(resourceId);
    }

    cacheMediaURLs(resourceId, media, options);
};

/**
 * @typedef HostURLOptions
 * @property {string} [auth]
 * @property {string} basePath
 * @property {string} [cookie]
 * @property {string} deviceId
 * @property {string} requestPath
 */

/**
 * @param {import('express').Request} request
 * @return {HostURLOptions}
 */
const getHostURLOptions = (request) => {
    const { __enketo_meta_deviceid: deviceId } = request.signedCookies;

    if (deviceId == null) {
        throw new error.ResponseError(401, 'Unauthorized');
    }

    return {
        auth: userModel.getCredentials(request),
        basePath: request.app.get('base path') ?? '',
        cookie: request.headers.cookie,
        deviceId,
        requestPath: request.url,
    };
};

/**
 * @param {HostURLOptions} options
 */
const getHostURL = async (options) => {
    const { basePath, deviceId, requestPath } = options;
    const mediaURLSegments = matchMediaURLSegments(requestPath);

    if (mediaURLSegments == null) {
        return requestPath;
    }

    const mediaURL = createMediaURL({
        ...mediaURLSegments,
        basePath,
    });

    if (mediaURL == null) {
        return requestPath;
    }

    const cacheKey = getCacheKey(deviceId, mediaURL);
    let hostURL = mediaMapCache.get(cacheKey);

    if (hostURL == null) {
        const { resourceId, resourceType } = mediaURLSegments;
        await rebuildMediaURLCache(resourceType, resourceId, options);

        hostURL = mediaMapCache.get(cacheKey);
    }

    return hostURL ?? requestPath;
};

/**
 * @param {Survey} survey
 * @return {Survey}
 */
const replaceMediaSources = (survey) => {
    const { media } = survey;

    let { form, model } = survey;

    if (media != null) {
        const JR_URL = /"jr:\/\/[\w-]+\/([^"]+)"/g;
        const replacer = (match, filename) => {
            if (media[filename]) {
                return `"${media[filename]}"`;
            }

            return match;
        };

        form = form.replace(JR_URL, replacer);
        model = model.replace(JR_URL, replacer);

        if (media['form_logo.png']) {
            form = form.replace(
                /(class="form-logo"\s*>)/,
                `$1<img src="${media['form_logo.png']}" alt="form logo">`
            );
        }
    }

    return {
        ...survey,
        form,
        model,
    };
};

module.exports = {
    cacheMediaURLs,
    getMediaURL,
    getHostURLOptions,
    getHostURL,
    replaceMediaSources,
    ResourceType,
};
