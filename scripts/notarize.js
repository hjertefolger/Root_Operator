/**
 * Notarization script for macOS
 *
 * CURRENTLY DISABLED - Code signing is not enabled.
 *
 * To enable code signing and notarization:
 * 1. Join the Apple Developer Program ($99/year)
 * 2. In package.json, change:
 *    - "identity": null  ->  "identity": "Developer ID Application: Your Name (TEAM_ID)"
 *    - "hardenedRuntime": false  ->  "hardenedRuntime": true
 * 3. Set environment variables:
 *    - APPLE_ID - Your Apple ID email
 *    - APPLE_APP_SPECIFIC_PASSWORD - App-specific password from appleid.apple.com
 *    - APPLE_TEAM_ID - Your Apple Developer Team ID
 *
 * To create an app-specific password:
 *   1. Go to https://appleid.apple.com
 *   2. Sign in and go to Security > App-Specific Passwords
 *   3. Generate a new password for "Root Operator Notarization"
 *
 * To find your Team ID:
 *   1. Go to https://developer.apple.com/account
 *   2. Look for "Team ID" in membership details
 */

const { notarize } = require('@electron/notarize');
const path = require('path');

exports.default = async function notarizing(context) {
    const { electronPlatformName, appOutDir } = context;

    // Only notarize on macOS
    if (electronPlatformName !== 'darwin') {
        console.log('Skipping notarization: not macOS');
        return;
    }

    // Check for required environment variables
    const appleId = process.env.APPLE_ID;
    const appleIdPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD;
    const teamId = process.env.APPLE_TEAM_ID;

    if (!appleId || !appleIdPassword || !teamId) {
        console.log('Skipping notarization: missing credentials');
        console.log('Set APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, and APPLE_TEAM_ID to enable');
        console.log('See scripts/notarize.js for setup instructions');
        return;
    }

    const appName = context.packager.appInfo.productFilename;
    const appPath = path.join(appOutDir, `${appName}.app`);

    console.log(`Notarizing ${appPath}...`);

    try {
        await notarize({
            appPath,
            appleId,
            appleIdPassword,
            teamId,
        });
        console.log('Notarization complete!');
    } catch (error) {
        console.error('Notarization failed:', error.message);
        // Don't throw - allow build to complete even if notarization fails
        // This allows local development builds without Apple credentials
    }
};
