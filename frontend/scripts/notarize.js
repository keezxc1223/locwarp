/**
 * Post-sign notarization hook for electron-builder.
 * Invoked via "afterSign" in package.json build config.
 *
 * Required environment variables (set in CI / local .env):
 *   APPLE_ID                     — your Apple developer account email
 *   APPLE_APP_SPECIFIC_PASSWORD  — app-specific password from appleid.apple.com
 *   APPLE_TEAM_ID                — 10-character team ID from developer.apple.com
 *
 * Install: npm install @electron/notarize --save-dev
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') })

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context
  if (electronPlatformName !== 'darwin') return   // skip on non-macOS

  const appleId = process.env.APPLE_ID
  const appleIdPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD
  const teamId = process.env.APPLE_TEAM_ID

  if (!appleId || !appleIdPassword) {
    console.warn('[notarize] APPLE_ID or APPLE_APP_SPECIFIC_PASSWORD not set — skipping notarization.')
    console.warn('[notarize] Set these in frontend/.env or as CI environment variables.')
    return
  }

  const appName = context.packager.appInfo.productFilename
  const appPath = `${appOutDir}/${appName}.app`

  console.log(`[notarize] Submitting ${appPath} to Apple Notary Service…`)
  console.log('[notarize] This typically takes 1–5 minutes.')

  try {
    const { notarize } = require('@electron/notarize')
    await notarize({ appPath, appleId, appleIdPassword, teamId })
    console.log('[notarize] ✅ Notarization successful!')
  } catch (err) {
    console.error('[notarize] ❌ Notarization failed:', err.message)
    // Re-throw so electron-builder marks the build as failed
    throw err
  }
}
