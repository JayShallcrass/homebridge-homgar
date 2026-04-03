import {
  Service,
  PlatformAccessory,
  Logger,
} from 'homebridge';
import axios from 'axios';
import { HomGarPlatform } from '../platform';
import { WeatherConfig } from '../api/types';

interface WeatherData {
  rainfall48h: number;
  forecastNext24h: number;
  temperature: number;
}

export class WeatherSensorAccessory {
  private rainfall48hService: Service;
  private forecastService: Service;
  private shouldWaterService: Service;
  private temperatureService: Service;

  private rainfall48h = 0;
  private forecastNext24h = 0;
  private temperature = 15;
  private shouldWater = false;

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
      .setCharacteristic(this.platform.Characteristic.Model, 'Weather Station')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, `${config.latitude},${config.longitude}`);

    // Rainfall 48h as a HumiditySensor (0-100 scale, where value = mm rainfall, capped at 100)
    this.rainfall48hService = this.accessory.getService('Rainfall 48h')
      || this.accessory.addService(this.platform.Service.HumiditySensor, 'Rainfall 48h', 'rainfall48h');
    this.rainfall48hService.getCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity)
      .onGet(() => Math.min(this.rainfall48h, 100));

    // Forecast next 24h as a HumiditySensor
    this.forecastService = this.accessory.getService('Rain Forecast 24h')
      || this.accessory.addService(this.platform.Service.HumiditySensor, 'Rain Forecast 24h', 'forecast24h');
    this.forecastService.getCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity)
      .onGet(() => Math.min(this.forecastNext24h, 100));

    // Temperature
    this.temperatureService = this.accessory.getService('Garden Temperature')
      || this.accessory.addService(this.platform.Service.TemperatureSensor, 'Garden Temperature', 'gardenTemp');
    this.temperatureService.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .onGet(() => this.temperature);

    // "Should Water" as OccupancySensor - detected = yes, water the plants
    this.shouldWaterService = this.accessory.getService('Should Water')
      || this.accessory.addService(this.platform.Service.OccupancySensor, 'Should Water', 'shouldWater');
    this.shouldWaterService.getCharacteristic(this.platform.Characteristic.OccupancyDetected)
      .onGet(() => this.shouldWater ? 1 : 0);

    this.startPolling();
  }

  private startPolling(): void {
    const intervalMinutes = this.config.pollInterval || 30;
    this.log.info(`Weather sensor polling every ${intervalMinutes} minutes for ${this.config.latitude}, ${this.config.longitude}`);

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
      this.rainfall48h = Math.round(weather.rainfall48h * 10) / 10;
      this.forecastNext24h = Math.round(weather.forecastNext24h * 10) / 10;
      this.temperature = Math.round(weather.temperature * 10) / 10;
      this.shouldWater = this.computeShouldWater(weather);

      this.rainfall48hService.updateCharacteristic(
        this.platform.Characteristic.CurrentRelativeHumidity,
        Math.min(this.rainfall48h, 100),
      );

      this.forecastService.updateCharacteristic(
        this.platform.Characteristic.CurrentRelativeHumidity,
        Math.min(this.forecastNext24h, 100),
      );

      this.temperatureService.updateCharacteristic(
        this.platform.Characteristic.CurrentTemperature,
        this.temperature,
      );

      this.shouldWaterService.updateCharacteristic(
        this.platform.Characteristic.OccupancyDetected,
        this.shouldWater ? 1 : 0,
      );

      this.log.info(
        `Weather update: ${this.rainfall48h}mm (48h), ${this.forecastNext24h}mm (forecast), ` +
        `${this.temperature}C, shouldWater=${this.shouldWater}`,
      );
    } catch (error) {
      this.log.error(
        'Weather fetch failed:',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async fetchWeather(): Promise<WeatherData> {
    const { latitude, longitude } = this.config;

    const response = await axios.get('https://api.open-meteo.com/v1/forecast', {
      params: {
        latitude,
        longitude,
        hourly: 'precipitation,temperature_2m',
        past_days: 2,
        forecast_days: 1,
        timezone: 'auto',
      },
      timeout: 10000,
    });

    const data = response.data;
    const hourlyPrecip: number[] = data.hourly?.precipitation || [];
    const hourlyTimes: string[] = data.hourly?.time || [];
    const hourlyTemps: number[] = data.hourly?.temperature_2m || [];

    const now = new Date();
    const cutoff48h = new Date(now.getTime() - 48 * 60 * 60 * 1000);
    const cutoff24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    let rainfall48h = 0;
    let forecastNext24h = 0;

    for (let i = 0; i < hourlyTimes.length; i++) {
      const time = new Date(hourlyTimes[i]);
      const precip = hourlyPrecip[i] || 0;

      if (time >= cutoff48h && time <= now) {
        rainfall48h += precip;
      }
      if (time > now && time <= cutoff24h) {
        forecastNext24h += precip;
      }
    }

    const temperature = hourlyTemps.length > 0
      ? hourlyTemps[hourlyTemps.length - 1]
      : 15;

    return { rainfall48h, forecastNext24h, temperature };
  }

  private computeShouldWater(weather: WeatherData): boolean {
    const skipThreshold = this.config.rainSkipThreshold ?? 10;
    const forecastSkip = this.config.forecastSkipThreshold ?? 5;

    // Winter: don't water
    if (this.config.seasonalAdjust !== false) {
      const month = new Date().getMonth();
      if (month >= 11 || month <= 1) {
        return false;
      }
    }

    if (weather.forecastNext24h >= forecastSkip) {
      return false;
    }

    if (weather.rainfall48h >= skipThreshold) {
      return false;
    }

    return true;
  }
}
