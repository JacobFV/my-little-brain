const { withAndroidManifest } = require('expo/config-plugins');
module.exports = function withNetworkPolicy(config, { allowLocal = false } = {}) {
  return withAndroidManifest(config, config => {
    const application = config.modResults.manifest.application?.[0];
    if (application) application.$['android:usesCleartextTraffic'] = allowLocal ? 'true' : 'false';
    return config;
  });
};
