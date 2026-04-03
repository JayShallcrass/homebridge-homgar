import axios from 'axios';
import { Logger } from 'homebridge';
import { HomGarApiClient } from './api/client';
import { HomGarHub, HomGarSubDevice } from './api/types';

export interface ScheduleZoneConfig {
  zone: number;
  duration: number;    // seconds
  enabled: boolean;
}

export interface SchedulingConfig {
  enabled: boolean;
  latitude: number;
  longitude: number;
  wateringTime: string;  // "HH:MM" in 24h format
  zones: ScheduleZoneConfig[];
  sequential: boolean;
  pauseZones?: number[];
  rainSkipThreshold?: number;     // mm in last 48h to skip entirely (default 10)
  rainReduceThreshold?: number;   // mm in last 48h to reduce 50% (default 5)
  forecastSkipThreshold?: number; // mm forecast next 24h to skip (default 5)
  seasonalAdjust?: boolean;       // auto-adjust by season (default true)
}

interface WeatherData {
  rainfall48h: number;     // mm
  forecastNext24h: number; // mm
  temperature: number;     // C
}

interface WateringDecision {
  shouldWater: boolean;
  durationMultiplier: number;
  reason: string;
}

export class IrrigationScheduler {
  private dailyTimer: ReturnType<typeof setTimeout> | null = null;
  private isWatering = false;
  private lastWeatherCheck: WeatherData | null = null;

  constructor(
    private readonly config: SchedulingConfig,
    private readonly client: HomGarApiClient,
    private readonly hub: HomGarHub,
    private readonly device: HomGarSubDevice,
    private readonly log: Logger,
  ) {
    if (!config.enabled) {
      this.log.info('Smart irrigation scheduler is disabled');
      return;
    }

    this.log.info(
      `Smart irrigation scheduler enabled: ` +
      `watering at ${config.wateringTime}, ` +
      `${config.zones.filter(z => z.enabled).length} zone(s), ` +
      `sequential=${config.sequential}`,
    );

    this.scheduleDailyRun();
  }

  stop(): void {
    if (this.dailyTimer) {
      clearTimeout(this.dailyTimer);
      this.dailyTimer = null;
    }
  }

  private scheduleDailyRun(): void {
    const now = new Date();
    const [hours, minutes] = this.config.wateringTime.split(':').map(Number);

    const nextRun = new Date(now);
    nextRun.setHours(hours, minutes, 0, 0);

    // If the time has passed today, schedule for tomorrow
    if (nextRun <= now) {
      nextRun.setDate(nextRun.getDate() + 1);
    }

    const msUntilRun = nextRun.getTime() - now.getTime();
    const hoursUntil = Math.round(msUntilRun / 1000 / 60 / 60 * 10) / 10;

    this.log.info(`Next scheduled watering check: ${nextRun.toLocaleString()} (${hoursUntil}h from now)`);

    this.dailyTimer = setTimeout(() => {
      this.runScheduledWatering();
      // Reschedule for tomorrow
      this.scheduleDailyRun();
    }, msUntilRun);
  }

  private async runScheduledWatering(): Promise<void> {
    if (this.isWatering) {
      this.log.warn('Skipping scheduled watering: already in progress');
      return;
    }

    try {
      this.log.info('=== Smart Irrigation Check ===');

      // Check weather
      const weather = await this.fetchWeather();
      this.lastWeatherCheck = weather;

      this.log.info(
        `Weather: ${weather.rainfall48h.toFixed(1)}mm rain (48h), ` +
        `${weather.forecastNext24h.toFixed(1)}mm forecast (24h), ` +
        `${weather.temperature.toFixed(1)}C`,
      );

      // Make watering decision
      const decision = this.makeDecision(weather);
      this.log.info(`Decision: ${decision.reason}`);

      if (!decision.shouldWater) {
        this.log.info('=== Skipping watering ===');
        return;
      }

      // Get enabled zones
      const activeZones = this.config.zones.filter(z => z.enabled);
      if (activeZones.length === 0) {
        this.log.info('No zones enabled for scheduled watering');
        return;
      }

      this.isWatering = true;

      // Pause heron/conflict zones
      const pauseZones = this.config.pauseZones || [];
      for (const pauseZone of pauseZones) {
        try {
          this.log.info(`Pausing zone ${pauseZone} during plant watering`);
          await this.client.controlValve(
            this.hub.mid,
            this.device.addr,
            this.device.deviceName || this.hub.did,
            this.device.productKey || '',
            pauseZone,
            'close',
            0,
          );
        } catch (err) {
          this.log.warn(`Failed to pause zone ${pauseZone}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // Run zones sequentially or in parallel
      if (this.config.sequential) {
        for (const zone of activeZones) {
          const duration = Math.round(zone.duration * decision.durationMultiplier);
          await this.runZone(zone.zone, duration);
        }
      } else {
        const promises = activeZones.map(zone => {
          const duration = Math.round(zone.duration * decision.durationMultiplier);
          return this.runZone(zone.zone, duration);
        });
        await Promise.all(promises);
      }

      // Resume paused zones
      for (const pauseZone of pauseZones) {
        this.log.info(`Resuming zone ${pauseZone} after plant watering`);
        // Don't actively open - just let the motion sensor automation handle it
      }

      this.log.info('=== Scheduled watering complete ===');
    } catch (error) {
      this.log.error(
        'Scheduled watering failed:',
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      this.isWatering = false;
    }
  }

  private async runZone(zoneNumber: number, durationSeconds: number): Promise<void> {
    this.log.info(`Starting zone ${zoneNumber} for ${Math.round(durationSeconds / 60)} minutes`);

    try {
      await this.client.controlValve(
        this.hub.mid,
        this.device.addr,
        this.device.deviceName || this.hub.did,
        this.device.productKey || '',
        zoneNumber,
        'open',
        durationSeconds,
      );

      // Wait for the zone to finish
      await new Promise(resolve => setTimeout(resolve, (durationSeconds + 10) * 1000));

      this.log.info(`Zone ${zoneNumber} finished`);
    } catch (error) {
      this.log.error(
        `Failed to run zone ${zoneNumber}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async fetchWeather(): Promise<WeatherData> {
    const { latitude, longitude } = this.config;

    // Open-Meteo: free, no API key, includes historical + forecast
    const response = await axios.get('https://api.open-meteo.com/v1/forecast', {
      params: {
        latitude,
        longitude,
        daily: 'precipitation_sum',
        hourly: 'precipitation',
        past_days: 2,
        forecast_days: 1,
        timezone: 'auto',
      },
      timeout: 10000,
    });

    const data = response.data;

    // Sum rainfall from the last 48 hours of hourly data
    const hourlyPrecip: number[] = data.hourly?.precipitation || [];
    const hourlyTimes: string[] = data.hourly?.time || [];
    const now = new Date();
    const cutoff48h = new Date(now.getTime() - 48 * 60 * 60 * 1000);

    let rainfall48h = 0;
    for (let i = 0; i < hourlyTimes.length; i++) {
      const time = new Date(hourlyTimes[i]);
      if (time >= cutoff48h && time <= now) {
        rainfall48h += hourlyPrecip[i] || 0;
      }
    }

    // Forecast: sum precipitation for remaining hours today + tomorrow
    let forecastNext24h = 0;
    const cutoff24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    for (let i = 0; i < hourlyTimes.length; i++) {
      const time = new Date(hourlyTimes[i]);
      if (time > now && time <= cutoff24h) {
        forecastNext24h += hourlyPrecip[i] || 0;
      }
    }

    // Current temperature from latest hourly reading
    const temperatures: number[] = data.hourly?.temperature_2m || [];
    const temperature = temperatures.length > 0
      ? temperatures[temperatures.length - 1]
      : 15;

    return { rainfall48h, forecastNext24h, temperature };
  }

  private makeDecision(weather: WeatherData): WateringDecision {
    const skipThreshold = this.config.rainSkipThreshold ?? 10;
    const reduceThreshold = this.config.rainReduceThreshold ?? 5;
    const forecastSkip = this.config.forecastSkipThreshold ?? 5;

    // Check forecast first
    if (weather.forecastNext24h >= forecastSkip) {
      return {
        shouldWater: false,
        durationMultiplier: 0,
        reason: `Skipping: ${weather.forecastNext24h.toFixed(1)}mm rain forecast in next 24h (threshold: ${forecastSkip}mm)`,
      };
    }

    // Check recent rainfall
    if (weather.rainfall48h >= skipThreshold) {
      return {
        shouldWater: false,
        durationMultiplier: 0,
        reason: `Skipping: ${weather.rainfall48h.toFixed(1)}mm rain in last 48h (threshold: ${skipThreshold}mm)`,
      };
    }

    if (weather.rainfall48h >= reduceThreshold) {
      return {
        shouldWater: true,
        durationMultiplier: 0.5,
        reason: `Reducing 50%: ${weather.rainfall48h.toFixed(1)}mm rain in last 48h (reduce threshold: ${reduceThreshold}mm)`,
      };
    }

    if (weather.rainfall48h >= 2) {
      return {
        shouldWater: true,
        durationMultiplier: 0.75,
        reason: `Reducing 25%: ${weather.rainfall48h.toFixed(1)}mm light rain in last 48h`,
      };
    }

    // Seasonal adjustment
    let seasonMultiplier = 1.0;
    if (this.config.seasonalAdjust !== false) {
      const month = new Date().getMonth();
      if (month >= 11 || month <= 1) {
        // Dec-Feb: skip entirely in winter
        return {
          shouldWater: false,
          durationMultiplier: 0,
          reason: 'Skipping: winter season (Dec-Feb)',
        };
      } else if (month >= 2 && month <= 3) {
        // Mar-Apr: spring, reduce
        seasonMultiplier = 0.7;
      } else if (month >= 9 && month <= 10) {
        // Oct-Nov: autumn, reduce
        seasonMultiplier = 0.6;
      }
      // May-Sep: full watering
    }

    return {
      shouldWater: true,
      durationMultiplier: seasonMultiplier,
      reason: `Watering: ${weather.rainfall48h.toFixed(1)}mm rain in last 48h, season multiplier ${seasonMultiplier}`,
    };
  }
}
