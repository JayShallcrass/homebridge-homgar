export interface ScheduleZoneConfig {
  zone: number;
  duration: number;
  enabled: boolean;
}

export interface SchedulingConfig {
  enabled: boolean;
  latitude: number;
  longitude: number;
  wateringTime: string;
  zones: ScheduleZoneConfig[];
  sequential: boolean;
  pauseZones?: number[];
  rainSkipThreshold?: number;
  rainReduceThreshold?: number;
  forecastSkipThreshold?: number;
  seasonalAdjust?: boolean;
}

export interface HomGarConfig {
  platform: string;
  name: string;
  email: string;
  password: string;
  areaCode?: string;
  pollInterval?: number;
  defaultWateringDuration?: number;
  scheduling?: SchedulingConfig;
}

export interface HomGarHome {
  hid: number;
  homeName: string;
}

export interface HomGarSubDevice {
  did: string;
  modelCode: number;
  model: string;
  displayModel?: string;
  name: string;
  addr: number;
  portNumber?: number;
  portDescribe?: string;
  alerts?: string;
  productKey?: string;
  deviceName?: string;
}

export interface HomGarHub {
  did: string;
  mid: string;
  modelCode: number;
  model: string;
  name: string;
  addr: number;
  subDevices: HomGarSubDevice[];
}

export interface DeviceStatus {
  id: string;
  value: string;
}

export interface ParsedSensorData {
  rfRssi?: number;
  battery?: number;
  temperature?: number;     // Celsius
  humidity?: number;        // %
  pressure?: number;        // hPa
  soilMoisture?: number;    // %
  light?: number;           // lux
  rainTotal?: number;       // mm
  rainHourly?: number;      // mm
  rainDaily?: number;       // mm
  rain7Day?: number;        // mm
}

export interface ParsedValveData {
  rfRssi?: number;
  battery?: number;
  zones: ValveZoneData[];
}

export interface ValveZoneData {
  zoneNumber: number;
  active: boolean;
  lastUsageLitres: number;
}

export interface AuthTokens {
  token: string;
  tokenExpires: number;     // UTC timestamp ms
  refreshToken: string;
  deviceId: string;
}
