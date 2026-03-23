const path = require('path');
const dotenv = require('dotenv');
const packageJson = require('../package.json');

const envFile = dotenv.config({
    path: path.join(__dirname, '..', '.env'),
    processEnv: {},
}).parsed || {};

function parseBoolean(value, fallback = false) {
    if (value == null || value === '') return fallback;
    return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function trimOrFallback(value, fallback) {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    return trimmed || fallback;
}

const baseConfig = packageJson.build || {};

function resolveEnv(name, fallback) {
    const runtimeValue = process.env[name];
    if (runtimeValue != null && runtimeValue !== '') return runtimeValue;
    const fileValue = envFile[name];
    if (fileValue != null && fileValue !== '') return fileValue;
    return fallback;
}

const updateRepoOwner = trimOrFallback(resolveEnv('UPDATE_REPO_OWNER'), 'hjertefolger');
const updateRepoName = trimOrFallback(resolveEnv('UPDATE_REPO_NAME'), 'Root_Operator');
const updateReleaseType = trimOrFallback(resolveEnv('UPDATE_RELEASE_TYPE'), 'release');
const updateVPrefixedTagName = parseBoolean(resolveEnv('UPDATE_VPREFIXED_TAG_NAME'), true);
const updatePrivate = parseBoolean(resolveEnv('UPDATE_PRIVATE'), false);

module.exports = {
    ...baseConfig,
    publish: [
        {
            provider: 'github',
            owner: updateRepoOwner,
            repo: updateRepoName,
            releaseType: updateReleaseType,
            vPrefixedTagName: updateVPrefixedTagName,
            private: updatePrivate,
        },
    ],
};
