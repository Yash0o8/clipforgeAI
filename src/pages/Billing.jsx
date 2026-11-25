import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Check, Gift, Sparkles } from 'lucide-react';
import { Badge } from '../components/common/Badge.jsx';
import { Button } from '../components/common/Button.jsx';
import { Panel, PanelBody, PanelHeader } from '../components/common/Panel.jsx';
import { TextField } from '../components/common/TextField.jsx';
import { EmptyState, ErrorState } from '../components/common/EmptyState.jsx';
import { LoaderBlock } from '../components/common/Loader.jsx';
import { useBilling } from '../hooks/useBilling.js';
import { useToast } from '../hooks/useToast.js';
import { claimReferral, startCheckout } from '../services/billingService.js';

/**
 * Freemium plans, monthly credits and the referral loop.
 *
 * No signup is required: credits belong to a browser-generated device id. The
 * referral link is therefore the growth lever — both sides get bonus minutes.
 */
export function BillingPage() {
  const {
    plans,
    account,
    loading,
    error,
    refresh,
    plansLoading,
    plansError,
    retryPlans,
  } = useBilling();
  const toast = useToast();
  const [searchParams] = useSearchParams();
  const [code, setCode] = useState(() => searchParams.get('ref') ?? '');
  const [busy, setBusy] = useState(false);
  const [checkoutBusy, setCheckoutBusy] = useState(null);

  const used = account?.usedMinutes ?? 0;
  const allowance = account?.allowanceMinutes ?? 0;
  const remaining = account?.remainingMinutes ?? allowance;
  const percent = allowance > 0 ? Math.min(100, (used / allowance) * 100) : 0;

  const onReferral = async () => {
    if (!code.trim()) return;
    setBusy(true);
    try {
      const result = await claimReferral(code.trim());
      toast.success(`+${result.bonusMinutesEach} minutes for both creators`, {
        body: 'Your referral bonus is available immediately.',
      });
      setCode('');
      await refresh();
    } catch (cause) {
      toast.error('Could not apply that code', { body: cause.message });
    } finally {
      setBusy(false);
    }
  };

  const onCheckout = async (plan) => {
    setCheckoutBusy(plan.id);
    try {
      const result = await startCheckout(plan.id);
      if (result.mode === 'stripe' && result.checkoutUrl) {
        window.location.assign(result.checkoutUrl);
        return;
      }
      toast.info('Online checkout is not configured', { body: result.message });
    } catch (cause) {
      toast.error('Could not start checkout', { body: cause.message });
    } finally {
      setCheckoutBusy(null);
    }
  };

  const referralLink =
    typeof window !== 'undefined' && account?.referralCode
      ? `${window.location.origin}/app/billing?ref=${account.referralCode}`
      : '';

  const copyLink = async () => {
    if (!referralLink) return;
    try {
      await navigator.clipboard.writeText(referralLink);
      toast.success('Invite link copied');
    } catch {
      toast.info('Your invite code', { body: account.referralCode });
    }
  };

  return (
    <div className="space-y-5">
      <header className="space-y-1">
        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-brand-400">
          Plans &amp; credits
        </p>
        <h1 className="text-2xl font-semibold tracking-tight text-primary sm:text-3xl">
          Create more, pay only when you scale
        </h1>
        <p className="max-w-2xl text-sm text-secondary">
          Start free with 30 minutes every month and a small watermark. Invite a creator friend and
          you both get 15 extra minutes.
        </p>
      </header>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <Panel>
          <PanelHeader
            title="Choose a plan"
            subtitle="Monthly processing minutes. Unused time does not roll over."
          />
          <PanelBody>
            {plansLoading ? (
              <LoaderBlock label="Loading plans" hint="Fetching the latest plans and credits." className="py-12" />
            ) : plansError ? (
              <ErrorState
                title="Could not load plans"
                message={plansError.message ?? 'The API did not answer. Try again.'}
                onRetry={() => { void retryPlans(); }}
                retryLabel="Retry"
              />
            ) : plans.length === 0 ? (
              <EmptyState
                title="No plans available"
                description="Plan details are not available right now. Check back in a moment."
                action={
                  <Button size="sm" variant="secondary" onClick={() => { void retryPlans(); }}>
                    Retry
                  </Button>
                }
              />
            ) : (
              <div className="grid gap-3 sm:grid-cols-3">
                {plans.map((plan) => {
                  const current = account?.plan === plan.id;
                  return (
                    <article
                      key={plan.id}
                      className={`flex flex-col rounded-xl border p-4 ${
                        current ? 'border-brand-500/60 bg-brand-500/[0.06]' : 'border-line bg-ink-900/60'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <h2 className="text-[15px] font-semibold text-primary">{plan.label}</h2>
                        {current && <Badge tone="brand" size="sm">Current</Badge>}
                      </div>
                      <p className="tabular mt-2 text-2xl font-semibold text-primary">
                        ₹{plan.priceInr}
                        <span className="text-[12px] font-normal text-faint"> / month</span>
                      </p>
                      <p className="tabular mt-1 text-[12px] text-secondary">
                        {plan.monthlyMinutes} processing minutes
                      </p>
                      <ul className="mt-3 flex-1 space-y-1.5">
                        {plan.features.map((feature) => (
                          <li key={feature} className="flex items-start gap-1.5 text-[11.5px] leading-relaxed text-secondary">
                            <Check aria-hidden className="mt-0.5 size-3 shrink-0 text-success" />
                            {feature}
                          </li>
                        ))}
                      </ul>
                      {plan.priceInr === 0 ? (
                        <Button className="mt-4" size="sm" variant="secondary" disabled>
                          Free tier — active
                        </Button>
                      ) : (
                        <Button
                          className="mt-4"
                          size="sm"
                          variant={plan.id === 'pro' ? 'primary' : 'subtle'}
                          loading={checkoutBusy === plan.id}
                          onClick={() => onCheckout(plan)}
                        >
                          <Sparkles aria-hidden className="size-3.5" />
                          Upgrade to {plan.label}
                        </Button>
                      )}
                    </article>
                  );
                })}
              </div>
            )}
          </PanelBody>
        </Panel>

        <div className="space-y-4">
          <Panel>
            <PanelHeader title="This month" subtitle="Resets every 30 days." />
            <PanelBody className="space-y-3">
              {error ? (
                <ErrorState
                  title="Could not load credits"
                  message={error.message ?? 'The API did not answer. Try again.'}
                  onRetry={() => { void refresh(); }}
                  retryLabel="Retry"
                />
              ) : loading && !account ? (
                <LoaderBlock label="Loading credits" hint="Checking this device's remaining minutes." className="py-10" />
              ) : (
                <>
                  <p className="tabular text-[13px] text-primary">
                    <span className="text-2xl font-semibold">{Math.round(remaining)}</span> min left
                    <span className="text-faint"> of {Math.round(allowance)}</span>
                  </p>
                  <div className="h-2 overflow-hidden rounded-full bg-ink-800" aria-hidden>
                    <div className="h-full rounded-full bg-brand-500" style={{ width: `${percent}%` }} />
                  </div>
                  <p className="tabular text-[11.5px] text-faint">
                    {used.toFixed(1)} min used
                    {account?.bonusMinutes ? ` · +${account.bonusMinutes} bonus min` : ''}
                  </p>
                </>
              )}
            </PanelBody>
          </Panel>

          <Panel>
            <PanelHeader title="Invite a creator" subtitle="Both of you get 15 bonus minutes." />
            <PanelBody className="space-y-3">
              <TextField
                label="Referral code"
                value={code}
                onChange={(event) => setCode(event.target.value.toUpperCase())}
                placeholder="Paste a friend's code"
                maxLength={32}
              />
              <Button fullWidth size="sm" variant="subtle" loading={busy} disabled={!code.trim()} onClick={onReferral}>
                <Gift aria-hidden className="size-3.5" />
                Claim bonus
              </Button>
              {referralLink && (
                <div className="rounded-lg border border-line bg-ink-900/60 p-3">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-faint">Your invite code</p>
                  <p className="tabular mt-1 text-[13px] font-semibold text-primary">{account.referralCode}</p>
                  <Button size="xs" variant="ghost" className="mt-2" onClick={copyLink}>
                    Copy invite link
                  </Button>
                </div>
              )}
            </PanelBody>
          </Panel>
        </div>
      </div>
    </div>
  );
}
