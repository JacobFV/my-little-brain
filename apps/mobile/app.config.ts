import type { ExpoConfig } from 'expo/config';
const development = process.env.EAS_BUILD_PROFILE
  ? process.env.EAS_BUILD_PROFILE === 'development'
  : process.env.NODE_ENV !== 'production';
const config: ExpoConfig = {
  name: 'My Little Brain',
  slug: 'my-little-brain',
  scheme: 'my-little-brain',
  version: '0.1.0',
  orientation: 'default',
  userInterfaceStyle: 'light',
  plugins: [['./plugins/with-network-policy.cjs', { allowLocal: development }]],
  ios: {
    supportsTablet: true,
    bundleIdentifier: 'com.mylittlebrain.mobile',
    infoPlist: {
      NSCameraUsageDescription:
        'Let your brain notice objects through your camera. Frames are processed on this device.',
      NSMicrophoneUsageDescription: 'Use your microphone to talk with your brain.',
      ...(development
        ? {
            NSLocalNetworkUsageDescription: 'Connect to your brain server on your local network.',
            NSAppTransportSecurity: {
              NSAllowsLocalNetworking: true,
              NSAllowsArbitraryLoadsInWebContent: true,
            },
          }
        : {}),
    },
  },
  android: {
    package: 'com.mylittlebrain.mobile',
    permissions: ['RECORD_AUDIO', 'CAMERA'],
    softwareKeyboardLayoutMode: 'resize',
  },
  extra: { allowLocal: development, serverUrl: process.env.EXPO_PUBLIC_BRAIN_URL || '' },
};
export default config;
