import { useCallback, useEffect, useState } from 'react';
import { getAccount, getDeviceId } from '../services/billingService.js';
import { useApp } from './useApp.js';

/**
 * Credit balance + plan catalog for the current browser.
 *
 * Plans come from `/meta` (already hydrated by AppProvider) so the pricing page
 * does not need a second request on every render. The account is fetched once
 * and can be refreshed after a referral or checkout.
 */
export function useBilling() {
  const {
    capabilities,
    isLoading: appLoading,
    loadError: appLoadError,
    refreshProjects,
  } = useApp();
  const deviceId = getDeviceId();
  const plans = capabilities?.features?.plans ?? [];
  const [account, setAccount] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  // Plans come from the app's `/meta` hydration, so retrying them means asking
  // the provider to hydrate again — the account refresh flow stays unchanged.
  const retryPlans = useCallback(async () => {
    if (!refreshProjects) return;
    await refreshProjects().catch(() => {});
  }, [refreshProjects]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getAccount();
      setAccount(data);
      setError(null);
      return data;
    } catch (cause) {
      setError(cause);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch outside the synchronous effect body: calling `refresh()` there would
  // cascade renders (it sets loading immediately). The promise boundary keeps
  // the initial balance load off the render path.
  useEffect(() => {
    let active = true;
    getAccount()
      .then((data) => {
        if (!active) return;
        setAccount(data);
        setError(null);
      })
      .catch((cause) => {
        if (active) setError(cause);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  return {
    deviceId,
    plans,
    account,
    error,
    loading,
    refresh,
    plansLoading: appLoading && !capabilities,
    // A provider error only blocks plans when the metadata itself is missing;
    // cached plans stay usable if a later project refresh fails.
    plansError: !capabilities ? appLoadError : null,
    retryPlans,
  };
}
