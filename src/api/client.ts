import axios, { AxiosInstance } from 'axios';
import { createHash, randomBytes } from 'crypto';
import { Logger } from 'homebridge';
import { API_URL, APP_CODE, LANG, TOKEN_SAFETY_MARGIN_MS } from '../settings';
import {
  AuthTokens,
  HomGarHome,
  HomGarHub,
  HomGarSubDevice,
  DeviceStatus,
  ParsedSensorData,
  ParsedValveData,
  ValveZoneData,
} from './types';

/** Network-level failures worth retrying. Everything else is a real error. */
const TRANSIENT_CODES = new Set([
  'ECONNABORTED', // axios timeout
  'ETIMEDOUT',
  'ENOTFOUND', // DNS miss on regionN.homgarus.com
  'EAI_AGAIN', // transient DNS failure
  'ECONNRESET',
  'ECONNREFUSED',
  'ENETUNREACH',
  'EPIPE',
]);

export class HomGarApiClient {
  private static readonly RETRY_ATTEMPTS = 3;
  private static readonly RETRY_BASE_MS = 500;

  private http: AxiosInstance;
  private auth: AuthTokens | null = null;
  private email: string;
  private passwordMd5: string;
  private areaCode: string;

  constructor(
    email: string,
    password: string,
    areaCode: string,
    private readonly log: Logger,
  ) {
    this.email = email;
    this.passwordMd5 = createHash('md5').update(password).digest('hex');
    this.areaCode = areaCode;

    this.http = axios.create({
      baseURL: API_URL,
      timeout: 15000,
      headers: {
        'Content-Type': 'application/json',
        'lang': LANG,
        'appCode': APP_CODE,
      },
    });
  }

  async login(): Promise<void> {
    // Generate a deterministic deviceId from email+areaCode to avoid session conflicts
    const deviceId = createHash('md5')
      .update(this.email + this.areaCode)
      .digest('hex');

    this.log.info('Authenticating with HomGar API...');

    const response = await this.http.post('/auth/basic/app/login', {
      areaCode: this.areaCode,
      phoneOrEmail: this.email,
      password: this.passwordMd5,
      deviceId,
    });

    const data = response.data;
    if (data.code !== 0) {
      throw new Error(`Login failed: ${data.msg || 'unknown error'} (code ${data.code})`);
    }

    const tokenExpiredSeconds = data.data.tokenExpired || 86400;
    this.auth = {
      token: data.data.token,
      tokenExpires: Date.now() + tokenExpiredSeconds * 1000,
      refreshToken: data.data.refreshToken || '',
      deviceId,
    };

    this.log.info('Authentication successful');
  }

  async ensureAuthenticated(): Promise<void> {
    if (!this.auth || Date.now() > this.auth.tokenExpires - TOKEN_SAFETY_MARGIN_MS) {
      await this.login();
    }
  }

  /**
   * True only for network-level faults. An API error (`code !== 0`) is a real
   * answer from HomGar and must not be retried, or a rejected command would be
   * sent three times.
   */
  static isTransient(error: unknown): boolean {
    if (!axios.isAxiosError(error)) {
      return false;
    }
    if (error.response) {
      return error.response.status >= 500 || error.response.status === 429;
    }
    return error.code !== undefined && TRANSIENT_CODES.has(error.code);
  }

  /**
   * Retry transient network failures with exponential backoff and jitter.
   * The HomGar cloud drops roughly 4% of polls; without this every blip
   * surfaced as an error and left the accessory showing stale state.
   */
  private async withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= HomGarApiClient.RETRY_ATTEMPTS; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;

        if (!HomGarApiClient.isTransient(error) || attempt === HomGarApiClient.RETRY_ATTEMPTS) {
          throw error;
        }

        const backoff = HomGarApiClient.RETRY_BASE_MS * 2 ** (attempt - 1);
        const delay = backoff + Math.floor(Math.random() * 250);
        this.log.debug(
          `${label} failed (attempt ${attempt}/${HomGarApiClient.RETRY_ATTEMPTS}), `
          + `retrying in ${delay}ms: ${error instanceof Error ? error.message : String(error)}`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    throw lastError;
  }

  private async get<T>(path: string, params?: Record<string, string>): Promise<T> {
    return this.withRetry(`GET ${path}`, async () => {
      await this.ensureAuthenticated();

      const response = await this.http.get(path, {
        params,
        headers: { auth: this.auth!.token },
      });

      const data = response.data;
      if (data.code !== 0) {
        throw new Error(`API error on ${path}: ${data.msg || 'unknown'} (code ${data.code})`);
      }

      return data.data;
    });
  }

  private async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    return this.withRetry(`POST ${path}`, async () => {
      await this.ensureAuthenticated();

      const response = await this.http.post(path, body, {
        headers: { auth: this.auth!.token },
      });

      const data = response.data;
      if (data.code !== 0) {
        // Code 4 = device already in requested state, treat as non-fatal
        if (data.code === 4) {
          this.log.debug(`API returned code 4 (already in state) for ${path}`);
          return data.data;
        }
        throw new Error(`API error on ${path}: ${data.msg || 'unknown'} (code ${data.code})`);
      }

      return data.data;
    });
  }

  async getHomes(): Promise<HomGarHome[]> {
    const data = await this.get<HomGarHome[]>('/app/member/appHome/list');
    return data || [];
  }

  async getDevices(hid: number): Promise<HomGarHub[]> {
    const data = await this.get<HomGarHub[]>('/app/device/getDeviceByHid', {
      hid: String(hid),
    });

    if (!Array.isArray(data)) {
      return [];
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (data as any[]).map((hub) => ({
      did: hub.did as string,
      mid: hub.mid as string,
      modelCode: hub.modelCode as number,
      model: hub.model as string,
      name: hub.name as string,
      addr: (hub.addr as number) || 1,
      subDevices: ((hub.subDevices as Record<string, unknown>[]) || [])
        .filter(sd => String(sd.did) !== '1')
        .map(sd => ({
          did: sd.did as string,
          modelCode: sd.modelCode as number,
          model: sd.model as string,
          displayModel: sd.displayModel as string | undefined,
          name: sd.name as string,
          addr: sd.addr as number,
          portNumber: sd.portNumber as number | undefined,
          portDescribe: sd.portDescribe as string | undefined,
          alerts: sd.alerts as string | undefined,
          productKey: (hub.productKey as string) || undefined,
          deviceName: (hub.deviceName as string) || undefined,
        })),
    }));
  }

  async getDeviceStatus(mid: string): Promise<DeviceStatus[]> {
    const data = await this.get<{ subDeviceStatus: DeviceStatus[] }>(
      '/app/device/getDeviceStatus',
      { mid },
    );

    return data?.subDeviceStatus || [];
  }

  async controlValve(
    mid: string,
    addr: number,
    deviceName: string,
    productKey: string,
    port: number,
    mode: 'open' | 'close',
    durationSeconds: number,
  ): Promise<void> {
    this.log.info(`${mode === 'open' ? 'Opening' : 'Closing'} valve zone ${port} (duration: ${durationSeconds}s)`);

    await this.post('/app/device/controlWorkMode', {
      mid,
      addr,
      deviceName,
      productKey,
      port,
      mode: mode === 'open' ? 1 : 0,
      duration: mode === 'open' ? durationSeconds : 0,
      param: '',
    });
  }

  // TLV type byte to value width mapping (from HA integration reverse-engineering)
  private static readonly TLV_WIDTHS: Record<number, number> = {
    0xD8: 1, 0xD9: 1, 0xDA: 1, 0xDB: 1, 0xDC: 1, 0xDD: 1,
    0xAD: 2, 0xAE: 2, 0xAF: 2,
    0xB7: 4, 0xB8: 4, 0xB9: 4,
    0x20: 2, 0x21: 2, 0x22: 2, 0x23: 2, 0x24: 2, 0x25: 2,
    0x26: 2, 0x27: 2, 0x28: 2,
  };

  // Parse TLV hex payload (11# prefix format)
  private parseTlvPayload(hex: string): Map<number, number> {
    const result = new Map<number, number>();
    let pos = 0;

    while (pos < hex.length) {
      if (pos + 2 > hex.length) break;
      const typeByte = parseInt(hex.substring(pos, pos + 2), 16);
      pos += 2;

      const width = HomGarApiClient.TLV_WIDTHS[typeByte];
      if (width === undefined) {
        // Unknown type byte, try to skip 2 chars and continue
        this.log.debug(`Unknown TLV type 0x${typeByte.toString(16)} at pos ${pos - 2}`);
        break;
      }

      const valueHex = hex.substring(pos, pos + width * 2);
      pos += width * 2;

      if (valueHex.length === width * 2) {
        result.set(typeByte, parseInt(valueHex, 16));
      }
    }

    return result;
  }

  parseValveData(value: string, portCount: number): ParsedValveData | null {
    if (!value) {
      return null;
    }

    // Handle TLV hex format (11# prefix)
    if (value.startsWith('11#')) {
      const hex = value.substring(3);
      const tlv = this.parseTlvPayload(hex);
      this.log.debug(`TLV parsed ${tlv.size} fields from hex payload`);

      // Extract zone active states from TLV
      // Type bytes 0x19-0x1C or 0xD8-0xDB typically hold zone states
      const zones: ValveZoneData[] = [];
      for (let i = 0; i < portCount; i++) {
        zones.push({
          zoneNumber: i + 1,
          active: false, // Will be updated when we understand the active flag
          lastUsageLitres: 0,
        });
      }

      return { rfRssi: undefined, zones };
    }

    // Handle comma-separated ASCII format with pipe-separated zones
    if (value.includes(',') || value.includes('|')) {
      const parts = value.split(';');
      const generalFields = (parts[0] || '').split(',');
      const rfRssi = parseInt(generalFields[1] || '0', 10);
      const devicePart = parts.slice(1).join(';');

      if (!devicePart) {
        return { rfRssi, zones: [] };
      }

      const zoneParts = devicePart.split('|');
      const zones: ValveZoneData[] = [];

      for (let i = 0; i < zoneParts.length; i++) {
        const fields = zoneParts[i].split(',');
        zones.push({
          zoneNumber: i + 1,
          active: parseInt(fields[0] || '0', 10) !== 0,
          lastUsageLitres: parseInt(fields[1] || '0', 10) * 0.1,
        });
      }

      return { rfRssi, zones };
    }

    // Handle raw hex without 11# prefix (param field from device discovery)
    // This is the comma-separated hex blocks format from the subDevice param field
    if (value.match(/^[0-9A-Fa-f,|/]+$/)) {
      const blocks = value.split('|');
      const zones: ValveZoneData[] = [];

      for (let i = 0; i < blocks.length && i < portCount; i++) {
        const blockParts = blocks[i].split(',');
        // First byte of first part often indicates active state
        const firstByte = parseInt(blockParts[0]?.substring(0, 2) || '0', 16);
        zones.push({
          zoneNumber: i + 1,
          active: (firstByte & 0x80) !== 0, // High bit = active
          lastUsageLitres: 0,
        });
      }

      return { rfRssi: undefined, zones };
    }

    this.log.debug(`Unrecognised valve data format: ${value.substring(0, 50)}...`);
    return null;
  }
}
