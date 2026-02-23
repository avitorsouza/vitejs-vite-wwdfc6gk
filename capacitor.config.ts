import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.seudominio.drivertracker',
  appName: 'DriverTracker',
  webDir: 'dist',
  android: {
    useLegacyBridge: true,
  },
};

export default config;
