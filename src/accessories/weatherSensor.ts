import {
  Service,
  PlatformAccessory,
  Logger,
} from 'homebridge';
import axios from 'axios';
import { HomGarPlatform } from '../platform';
import { WeatherConfig } from '../api/types';

interface WeatherData {
  rainfall24h: number;       // mm
  et0: number;               // mm (evapotranspiration)
  forecastRain24h: number;   // mm
  temperature: number;       // C
  windSpeed: number;         // km/h
  maxTempToday: number;      // C
}

export class WeatherSensorAccessory {
  private shouldWaterService: Service;
  private shouldWater = false;
  private waterBalance = 0; // mm: positive = wet, negative = deficit
  private lastBalanceUpdate: string | null = null; // YYYY-MM-DD of last daily update
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly platform: HomGarPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly config: WeatherConfig,
    private readonly log: Logger,
  ) {
    const infoService = this.accessory.getService(this.platform.Service.AccessoryInformation)!;
    infoService
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Open-Meteo')
      .setCharacteristic(this.platform.Characteristic.Model, 'Smart Irrigation')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, `${config.latitude},${config.longitude}`);

    // Remove old services from previous versions
    for (const name of ['Rainfall 48h', 'Rain Forecast 24h', 'Garden Temperature']) {
      const old = this.accessory.getService(name);
      if (old) {
        this.accessory.removeService(old);
        this.log.info(`Removed legacy sensor: ${name}`);
      }
    }

    // Migrate from OccupancySensor to ContactSensor if needed
    const oldOccupancy = this.accessory.getService(this.platform.Service.OccupancySensor);
    if (oldOccupancy) {
      this.accessory.removeService(oldOccupancy);
      this.log.info('Migrated Should Water from OccupancySensor to ContactSensor');
    }

    // "Should Water" as ContactSensor — open = water needed, closed = skip
    this.shouldWaterService = this.accessory.getService('Should Water')
      || this.accessory.addService(this.platform.Service.ContactSensor, 'Should Water', 'shouldWater');
    this.shouldWaterService.getCharacteristic(this.platform.Characteristic.ContactSensorState)
      .onGet(() => this.shouldWater
        ? this.platform.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED  // open = water needed
        : this.platform.Characteristic.ContactSensorState.CONTACT_DETECTED);     // closed = skip

    // Restore water balance from context if available
    if (this.accessory.context.waterBalance !== undefined) {
      this.waterBalance = this.accessory.context.waterBalance;
      this.lastBalanceUpdate = this.accessory.context.lastBalanceUpdate || null;
      this.log.info(`Restored water balance: ${this.waterBalance.toFixed(1)}mm (last update: ${this.lastBalanceUpdate})`);
    }

    this.startPolling();
  }

  private startPolling(): void {
    const intervalMinutes = this.config.pollInterval || 30;
    this.log.info(`Weather polling every ${intervalMinutes}min for ${this.config.latitude}, ${this.config.longitude}`);

    this.fetchAndUpdate();
    this.pollTimer = setInterval(() => this.fetchAndUpdate(), intervalMinutes * 60 * 1000);
  }

  stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async fetchAndUpdate(): Promise<void> {
    try {
      const weather = await this.fetchWeather();

      // Update daily water balance (once per day)
      this.updateWaterBalance(weather);

      // Compute decision
      const previousState = this.shouldWater;
      this.shouldWater = this.computeShouldWater(weather);

      this.shouldWaterService.updateCharacteristic(
        this.platform.Characteristic.ContactSensorState,
        this.shouldWater
          ? this.platform.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
          : this.platform.Characteristic.ContactSensorState.CONTACT_DETECTED,
      );

      // Persist balance to accessory context
      this.accessory.context.waterBalance = this.waterBalance;
      this.accessory.context.lastBalanceUpdate = this.lastBalanceUpdate;

      // Log with decision reason
      const reason = this.getDecisionReason(weather);
      this.log.info(
        `Weather: balance=${this.waterBalance.toFixed(1)}mm, ` +
        `rain24h=${weather.rainfall24h.toFixed(1)}mm, ET0=${weather.et0.toFixed(1)}mm, ` +
        `forecast=${weather.forecastRain24h.toFixed(1)}mm, ` +
        `temp=${weather.temperature.toFixed(0)}C, wind=${weather.windSpeed.toFixed(0)}km/h — ` +
        `${reason}`,
      );

      if (this.shouldWater !== previousState) {
        this.log.info(`Should Water changed: ${previousState} → ${this.shouldWater}`);
      }
    } catch (error) {
      this.log.error(
        'Weather fetch failed:',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private updateWaterBalance(weather: WeatherData): void {
    const today = new Date().toISOString().split('T')[0];

    if (this.lastBalanceUpdate === today) {
      return; // Already updated today
    }

    // Daily balance: rain adds moisture, ET removes it
    this.waterBalance += weather.rainfall24h;
    this.waterBalance -= weather.et0;

    // Cap at 0 — don't accumulate surplus beyond saturation
    this.waterBalance = Math.min(this.waterBalance, 0);

    // Floor at -25 — don't let deficit grow beyond what watering can reasonably fix
    this.waterBalance = Math.max(this.waterBalance, -25);

    this.lastBalanceUpdate = today;
    this.log.info(`Water balance updated: +${weather.rainfall24h.toFixed(1)}mm rain, -${weather.et0.toFixed(1)}mm ET = ${this.waterBalance.toFixed(1)}mm`);
  }

  private computeShouldWater(weather: WeatherData): boolean {
    // Winter: off entirely (Dec-Feb)
    if (this.config.seasonalAdjust !== false) {
      const month = new Date().getMonth();
      if (month >= 11 || month <= 1) {
        return false;
      }
    }

    // Frost protection: skip if below 2C
    if (weather.temperature < 2) {
      return false;
    }

    // Wind check: skip if too windy (default 30 km/h)
    const windLimit = this.config.windSkipThreshold ?? 30;
    if (weather.windSpeed > windLimit) {
      return false;
    }

    // Forecast: skip if significant rain coming (default 8mm)
    const forecastSkip = this.config.forecastSkipThreshold ?? 8;
    if (weather.forecastRain24h >= forecastSkip) {
      return false;
    }

    // Water balance: water if deficit exceeds threshold (default -2mm)
    const deficitThreshold = this.config.deficitThreshold ?? -2;
    if (this.waterBalance > deficitThreshold) {
      return false; // Soil has enough moisture
    }

    return true;
  }

  private getDecisionReason(weather: WeatherData): string {
    if (this.config.seasonalAdjust !== false) {
      const month = new Date().getMonth();
      if (month >= 11 || month <= 1) {
        return 'SKIP: winter (Dec-Feb)';
      }
    }

    if (weather.temperature < 2) {
      return `SKIP: frost protection (${weather.temperature.toFixed(0)}C)`;
    }

    const windLimit = this.config.windSkipThreshold ?? 30;
    if (weather.windSpeed > windLimit) {
      return `SKIP: too windy (${weather.windSpeed.toFixed(0)}km/h, limit ${windLimit})`;
    }

    const forecastSkip = this.config.forecastSkipThreshold ?? 8;
    if (weather.forecastRain24h >= forecastSkip) {
      return `SKIP: rain forecast (${weather.forecastRain24h.toFixed(1)}mm coming)`;
    }

    const deficitThreshold = this.config.deficitThreshold ?? -2;
    if (this.waterBalance > deficitThreshold) {
      return `SKIP: soil OK (balance ${this.waterBalance.toFixed(1)}mm, threshold ${deficitThreshold}mm)`;
    }

    return `WATER: deficit ${this.waterBalance.toFixed(1)}mm`;
  }

  private async fetchWeather(): Promise<WeatherData> {
    const { latitude, longitude } = this.config;

    const response = await axios.get('https://api.open-meteo.com/v1/forecast', {
      params: {
        latitude,
        longitude,
        daily: 'precipitation_sum,et0_fao_evapotranspiration,temperature_2m_max',
        hourly: 'precipitation,temperature_2m,wind_speed_10m',
        past_days: 1,
        forecast_days: 1,
        timezone: 'auto',
      },
      timeout: 10000,
    });

    const data = response.data;

    // Daily values — yesterday's rain and ET
    const dailyPrecip: number[] = data.daily?.precipitation_sum || [];
    const dailyET: number[] = data.daily?.et0_fao_evapotranspiration || [];
    const dailyMaxTemp: number[] = data.daily?.temperature_2m_max || [];

    const rainfall24h = dailyPrecip.length > 0 ? dailyPrecip[0] : 0;
    const et0 = dailyET.length > 0 ? dailyET[0] : 3; // Default 3mm/day if unavailable
    const maxTempToday = dailyMaxTemp.length > 1 ? dailyMaxTemp[1] : dailyMaxTemp[0] || 20;

    // Hourly values — current conditions + forecast
    const hourlyPrecip: number[] = data.hourly?.precipitation || [];
    const hourlyTimes: string[] = data.hourly?.time || [];
    const hourlyTemps: number[] = data.hourly?.temperature_2m || [];
    const hourlyWind: number[] = data.hourly?.wind_speed_10m || [];

    const now = new Date();
    const cutoff24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    // Forecast rain (next 24h)
    let forecastRain24h = 0;
    for (let i = 0; i < hourlyTimes.length; i++) {
      const time = new Date(hourlyTimes[i]);
      if (time > now && time <= cutoff24h) {
        forecastRain24h += hourlyPrecip[i] || 0;
      }
    }

    // Current temperature and wind (latest hourly reading before now)
    let temperature = 15;
    let windSpeed = 0;
    for (let i = hourlyTimes.length - 1; i >= 0; i--) {
      const time = new Date(hourlyTimes[i]);
      if (time <= now) {
        temperature = hourlyTemps[i] ?? 15;
        windSpeed = hourlyWind[i] ?? 0;
        break;
      }
    }

    return { rainfall24h, et0, forecastRain24h, temperature, windSpeed, maxTempToday };
  }
}
