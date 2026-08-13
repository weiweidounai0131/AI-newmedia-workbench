const { execFileSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function adHocSignMac(context) {
  if (context.electronPlatformName !== 'darwin' || process.env.APPLE_CERT_BASE64) return;

  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' });
};
