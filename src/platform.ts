import {
  API,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
  Characteristic,
} from 'homebridge';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { HomGarApiClient } from './api/client';
import { HomGarConfig, HomGarHub, HomGarSubDevice } from './api/types';
import { WaterTimerAccessory } from './accessories/waterTimer';
import { IrrigationScheduler } from './scheduler';

export class HomGarPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;
  public readonly config: HomGarConfig;

  private readonly accessories: PlatformAccessory[] = [];
  private readonly activeAccessories: Map<string, WaterTimerAccessory> = new Map();
  private client: HomGarApiClient | null = null;
  private scheduler: IrrigationScheduler | null = null;

  constructor(
    public readonly log: Logger,
    config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.config = config as unknown as HomGarConfig;

    if (!this.config.email || !this.config.password) {
      this.log.error('Missing email or password in config. Plugin will not start.');
      return;
    }

    this.log.info('Initialising HomGar platform');

    this.api.on('didFinishLaunching', () => {
      this.discoverDevices();
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    this.accessories.push(accessory);
  }

  private async discoverDevices(): Promise<void> {
    try {
      const areaCode = this.config.areaCode || '44'; // Default to UK
      this.client = new HomGarApiClient(
        this.config.email,
        this.config.password,
        areaCode,
        this.log,
      );

      await this.client.login();

      const homes = await this.client.getHomes();
      this.log.info(`Found ${homes.length} home(s)`);

      const discoveredUuids: string[] = [];

      for (const home of homes) {
        this.log.info(`Discovering devices in home: ${home.homeName}`);
        const hubs = await this.client.getDevices(home.hid);

        for (const hub of hubs) {
          this.log.info(`Found hub: ${hub.name} (${hub.model}, mid: ${hub.mid})`);

          for (const subDevice of hub.subDevices) {
            this.log.info(`  Sub-device: ${subDevice.name} (${subDevice.model}, addr: ${subDevice.addr})`);

            // For now, only create accessories for valve/timer devices
            // Sensor support can be added later
            if (this.isTimerDevice(subDevice)) {
              // Use portNumber from API, fall back to model-based detection
              const zoneCount = subDevice.portNumber || this.getZoneCount(subDevice);
              const portNames = subDevice.portDescribe?.split('|') || [];

              for (let zone = 1; zone <= zoneCount; zone++) {
                const uuid = this.api.hap.uuid.generate(`${subDevice.did}-zone${zone}`);
                discoveredUuids.push(uuid);

                const displayName = portNames[zone - 1]?.trim()
                  || (zoneCount > 1 ? `${subDevice.name} Zone ${zone}` : subDevice.name);

                const existingAccessory = this.accessories.find(a => a.UUID === uuid);

                if (existingAccessory) {
                  this.log.info(`Restoring accessory from cache: ${displayName}`);
                  existingAccessory.context.device = subDevice;
                  existingAccessory.context.hub = hub;
                  existingAccessory.context.zone = zone;
                  existingAccessory.displayName = displayName;
                  this.api.updatePlatformAccessories([existingAccessory]);
                  this.createTimerHandler(existingAccessory, hub, subDevice, zone);
                } else {
                  this.log.info(`Adding new accessory: ${displayName}`);
                  const accessory = new this.api.platformAccessory(displayName, uuid);
                  accessory.context.device = subDevice;
                  accessory.context.hub = hub;
                  accessory.context.zone = zone;
                  this.createTimerHandler(accessory, hub, subDevice, zone);
                  this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
                }
              }
            }
          }
        }
      }

      // Remove stale accessories
      for (const accessory of this.accessories) {
        if (!discoveredUuids.includes(accessory.UUID)) {
          this.log.info('Removing stale accessory:', accessory.displayName);
          this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        }
      }

      // Start smart irrigation scheduler if configured
      if (this.config.scheduling?.enabled && this.client) {
        // Find the first timer device to attach the scheduler to
        for (const home of homes) {
          const homeHubs = await this.client.getDevices(home.hid);
          for (const hub of homeHubs) {
            for (const subDevice of hub.subDevices) {
              if (this.isTimerDevice(subDevice)) {
                this.scheduler = new IrrigationScheduler(
                  this.config.scheduling,
                  this.client,
                  hub,
                  subDevice,
                  this.log,
                );
                break;
              }
            }
            if (this.scheduler) break;
          }
          if (this.scheduler) break;
        }
      }
    } catch (error) {
      this.log.error(
        'Failed to discover devices:',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private createTimerHandler(
    accessory: PlatformAccessory,
    hub: HomGarHub,
    device: HomGarSubDevice,
    zone: number,
  ): void {
    if (!this.client) {
      return;
    }

    const key = `${device.did}-zone${zone}`;
    const existing = this.activeAccessories.get(key);
    if (existing) {
      existing.stopPolling();
    }

    const handler = new WaterTimerAccessory(
      this,
      accessory,
      this.client,
      hub,
      device,
      zone,
      this.log,
    );

    this.activeAccessories.set(key, handler);
  }

  private isTimerDevice(device: HomGarSubDevice): boolean {
    const timerModels = ['WT-13W', 'WT-24W', 'HTV213FRF', 'HTV0540FRF', 'HTV245FRF'];
    if (timerModels.some(m => device.model.toUpperCase().includes(m.toUpperCase()))) {
      return true;
    }
    // Also check model codes for known valve types
    const timerModelCodes = [261, 263, 266, 267, 272];
    return timerModelCodes.includes(device.modelCode);
  }

  private getZoneCount(device: HomGarSubDevice): number {
    const model = device.model.toUpperCase();
    if (model.includes('WT-24W') || model.includes('HTV213FRF')) {
      return 2;
    }
    if (model.includes('HTV245FRF') || model.includes('HTV0540FRF')) {
      return 4;
    }
    return 1; // Default single zone (WT-13W)
  }
}
