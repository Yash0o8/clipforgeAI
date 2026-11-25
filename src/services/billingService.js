/**
 * Billing API client.
 *
 * The zero-friction flow deliberately has no signup: a random id is generated
 * in the browser and kept in localStorage. The API attributes credits to that
 * id, so the same device id must be sent when processing or exporting.
 */

import { get, post } from './api.js';

const DEVICE_KEY = 'clipforge.deviceId';

/** Stable anonymous identity for credit accounting (no account required). */
export function getDeviceId() {
  if (typeof localStorage === 'undefined') return 'device-local';
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) {
    const random =
      globalThis.crypto?.randomUUID?.() ??
      `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
    id = `dev_${random.replace(/-/g, '').slice(0, 24)}`;
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}

export async function getPlans({ signal } = {}) {
  const payload = await get('/billing/plans', { signal });
  return Array.isArray(payload?.plans) ? payload.plans : [];
}

export async function getAccount({ signal } = {}) {
  return post('/billing/account', { deviceId: getDeviceId() }, { signal });
}

export async function claimReferral(code, { signal } = {}) {
  return post('/billing/referral', { deviceId: getDeviceId(), code }, { signal });
}

export async function startCheckout(planId, { signal } = {}) {
  return post('/billing/checkout', { deviceId: getDeviceId(), planId }, { signal });
}
