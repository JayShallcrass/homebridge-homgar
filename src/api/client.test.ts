import { describe, it, expect } from 'vitest';
import { AxiosError } from 'axios';
import { HomGarApiClient } from './client';

/** Build an axios error with no response, as a network fault produces. */
function networkError(code: string): AxiosError {
  const error = new AxiosError(`socket fail: ${code}`);
  error.code = code;
  return error;
}

/** Build an axios error carrying an HTTP response. */
function httpError(status: number): AxiosError {
  const error = new AxiosError(`http ${status}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  error.response = { status } as any;
  return error;
}

describe('HomGarApiClient.isTransient', () => {
  it('retries the faults actually seen in the Homebridge log', () => {
    // 249 timeouts and 4 DNS misses on regionN.homgarus.com over 13 days
    expect(HomGarApiClient.isTransient(networkError('ECONNABORTED'))).toBe(true);
    expect(HomGarApiClient.isTransient(networkError('ENOTFOUND'))).toBe(true);
    expect(HomGarApiClient.isTransient(networkError('ETIMEDOUT'))).toBe(true);
    expect(HomGarApiClient.isTransient(networkError('EAI_AGAIN'))).toBe(true);
    expect(HomGarApiClient.isTransient(networkError('ECONNRESET'))).toBe(true);
  });

  it('retries server-side faults and rate limiting', () => {
    expect(HomGarApiClient.isTransient(httpError(500))).toBe(true);
    expect(HomGarApiClient.isTransient(httpError(502))).toBe(true);
    expect(HomGarApiClient.isTransient(httpError(429))).toBe(true);
  });

  it('does NOT retry client errors, which would resend a rejected command', () => {
    expect(HomGarApiClient.isTransient(httpError(400))).toBe(false);
    expect(HomGarApiClient.isTransient(httpError(401))).toBe(false);
    expect(HomGarApiClient.isTransient(httpError(404))).toBe(false);
  });

  it('does NOT retry a real API answer, which is a plain Error not an AxiosError', () => {
    // `code !== 0` from HomGar is a considered response; retrying it would send
    // a valve command up to three times.
    expect(HomGarApiClient.isTransient(new Error('API error on /x: bad (code 7)'))).toBe(false);
    expect(HomGarApiClient.isTransient(undefined)).toBe(false);
    expect(HomGarApiClient.isTransient(null)).toBe(false);
    expect(HomGarApiClient.isTransient('timeout')).toBe(false);
  });

  it('does NOT retry an unrecognised network code', () => {
    expect(HomGarApiClient.isTransient(networkError('ERR_BAD_OPTION'))).toBe(false);
  });
});
