import {
  Service,
  Characteristic,
  PlatformAccessory,
  CharacteristicValue,
  Logger,
} from 'homebridge';
import { HomGarPlatform } from '../platform';
import { HomGarApiClient } from '../api/client';
import { HomGarSubDevice, HomGarHub } from '../api/types';
import { DEFAULT_WATERING_DURATION } from '../settings';

export class WaterTimerAccessory {
  private valveService: Service;

  private isActive = false;
  private isInUse = false;
  private remainingDuration = 0;
  private setDuration: number;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private countdownTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly platform: HomGarPlatform,
    private readonly accessory: PlatformAccessory,
    private readonly client: HomGarApiClient,
    private readonly hub: HomGarHub,
    private readonly device: HomGarSubDevice,
    private readonly zoneNumber: number,
    private readonly log: Logger,
  ) {
    this.setDuration = this.platform.config.defaultWateringDuration || DEFAULT_WATERING_DURATION;

    // Accessory information
    const infoService = this.accessory.getService(this.platform.Service.AccessoryInformation)!;
    infoService
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Diivoo/HomGar')
      .setCharacteristic(this.platform.Characteristic.Model, device.model)
      .setCharacteristic(this.platform.Characteristic.SerialNumber, device.did);

    // Valve service (Irrigation type)
    this.valveService = this.accessory.getService(this.platform.Service.Valve)
      || this.accessory.addService(this.platform.Service.Valve, device.name);

    this.valveService.setCharacteristic(
      this.platform.Characteristic.ValveType,
      this.platform.Characteristic.ValveType.IRRIGATION,
    );

    this.valveService.getCharacteristic(this.platform.Characteristic.Active)
      .onGet(() => this.isActive
        ? this.platform.Characteristic.Active.ACTIVE
        : this.platform.Characteristic.Active.INACTIVE)
      .onSet(this.handleSetActive.bind(this));

    this.valveService.getCharacteristic(this.platform.Characteristic.InUse)
      .onGet(() => this.isInUse
        ? this.platform.Characteristic.InUse.IN_USE
        : this.platform.Characteristic.InUse.NOT_IN_USE);

    this.valveService.getCharacteristic(this.platform.Characteristic.SetDuration)
      .setProps({ maxValue: 3600 })
      .onGet(() => this.setDuration)
      .onSet((value: CharacteristicValue) => {
        this.setDuration = value as number;
        this.log.debug(`Set watering duration to ${this.setDuration}s`);
      });

    this.valveService.getCharacteristic(this.platform.Characteristic.RemainingDuration)
      .setProps({ maxValue: 3600 })
      .onGet(() => this.remainingDuration);

    // Start polling
    this.startPolling();
  }

  private startPolling(): void {
    const interval = (this.platform.config.pollInterval || 120) * 1000;
    this.log.info(`Starting status polling for ${this.device.name} every ${interval / 1000}s`);

    this.pollStatus();
    this.pollTimer = setInterval(() => this.pollStatus(), interval);
  }

  stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.countdownTimer) {
      clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }
  }

  private async pollStatus(): Promise<void> {
    try {
      this.log.debug(`Polling ${this.device.name}...`);
      const statuses = await this.client.getDeviceStatus(this.hub.mid);

      const deviceKey = `D${String(this.device.addr).padStart(2, '0')}`;
      const deviceStatus = statuses.find(s => s.id === deviceKey);

      if (!deviceStatus) {
        this.log.debug(`No status for ${deviceKey}`);
        return;
      }

      const valveData = this.client.parseValveData(deviceStatus.value, this.device.portNumber || 1);
      if (!valveData) {
        return;
      }

      const zone = valveData.zones.find(z => z.zoneNumber === this.zoneNumber);
      if (!zone) {
        return;
      }

      const wasInUse = this.isInUse;
      this.isInUse = zone.active;
      this.isActive = zone.active;

      this.valveService.updateCharacteristic(
        this.platform.Characteristic.Active,
        this.isActive
          ? this.platform.Characteristic.Active.ACTIVE
          : this.platform.Characteristic.Active.INACTIVE,
      );

      this.valveService.updateCharacteristic(
        this.platform.Characteristic.InUse,
        this.isInUse
          ? this.platform.Characteristic.InUse.IN_USE
          : this.platform.Characteristic.InUse.NOT_IN_USE,
      );

      // If valve just turned off, reset remaining duration
      if (wasInUse && !this.isInUse) {
        this.remainingDuration = 0;
        this.stopCountdown();
        this.valveService.updateCharacteristic(
          this.platform.Characteristic.RemainingDuration,
          0,
        );
        this.log.info(`${this.device.name}: Watering finished (used ${zone.lastUsageLitres.toFixed(1)}L)`);
      }

      if (this.isInUse) {
        this.log.debug(`${this.device.name}: Active, ${this.remainingDuration}s remaining`);
      }
    } catch (error) {
      this.log.error(
        `Failed to poll ${this.device.name}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async handleSetActive(value: CharacteristicValue): Promise<void> {
    const shouldStart = value === this.platform.Characteristic.Active.ACTIVE;

    try {
      if (shouldStart && !this.isInUse) {
        this.log.info(`Starting watering on ${this.device.name} for ${this.setDuration}s`);

        await this.client.controlValve(
          this.hub.mid,
          this.device.addr,
          this.device.deviceName || this.hub.did,
          this.device.productKey || '',
          this.zoneNumber,
          'open',
          this.setDuration,
        );

        this.isActive = true;
        this.isInUse = true;
        this.remainingDuration = this.setDuration;
        this.startCountdown();

        this.valveService.updateCharacteristic(
          this.platform.Characteristic.InUse,
          this.platform.Characteristic.InUse.IN_USE,
        );
        this.valveService.updateCharacteristic(
          this.platform.Characteristic.RemainingDuration,
          this.remainingDuration,
        );
      } else if (!shouldStart && this.isInUse) {
        this.log.info(`Stopping watering on ${this.device.name}`);

        await this.client.controlValve(
          this.hub.mid,
          this.device.addr,
          this.device.deviceName || this.hub.did,
          this.device.productKey || '',
          this.zoneNumber,
          'close',
          0,
        );

        this.isActive = false;
        this.isInUse = false;
        this.remainingDuration = 0;
        this.stopCountdown();

        this.valveService.updateCharacteristic(
          this.platform.Characteristic.InUse,
          this.platform.Characteristic.InUse.NOT_IN_USE,
        );
        this.valveService.updateCharacteristic(
          this.platform.Characteristic.RemainingDuration,
          0,
        );
      }
    } catch (error) {
      this.log.error(
        `Failed to control ${this.device.name}:`,
        error instanceof Error ? error.message : String(error),
      );

      // Revert the characteristic to the actual state
      setTimeout(() => {
        this.valveService.updateCharacteristic(
          this.platform.Characteristic.Active,
          this.isActive
            ? this.platform.Characteristic.Active.ACTIVE
            : this.platform.Characteristic.Active.INACTIVE,
        );
      }, 100);
    }
  }

  private startCountdown(): void {
    this.stopCountdown();
    this.countdownTimer = setInterval(() => {
      if (this.remainingDuration > 0) {
        this.remainingDuration--;
        this.valveService.updateCharacteristic(
          this.platform.Characteristic.RemainingDuration,
          this.remainingDuration,
        );
      } else {
        this.stopCountdown();
      }
    }, 1000);
  }

  private stopCountdown(): void {
    if (this.countdownTimer) {
      clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }
  }
}
