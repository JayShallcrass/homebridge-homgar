export const PLATFORM_NAME = 'HomGar';
export const PLUGIN_NAME = 'homebridge-homgar';

export const API_URL = 'https://region3.homgarus.com';
export const APP_CODE = '1';
export const LANG = 'en';

export const DEFAULT_POLL_INTERVAL = 120;
export const MIN_POLL_INTERVAL = 60;
export const DEFAULT_WATERING_DURATION = 600; // 10 minutes in seconds

export const TOKEN_SAFETY_MARGIN_MS = 60 * 60 * 1000; // Re-login if < 60 min remaining
