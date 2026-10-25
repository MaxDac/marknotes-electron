import type { Settings } from './db';

export const ONBOARDING_SETTING = 'onboardingHandled';

export async function loadOnboardingHandled(settings: Pick<Settings, 'get'>): Promise<boolean> {
  return (await settings.get<unknown>(ONBOARDING_SETTING, false)) === true;
}

export async function handleOnboarding(settings: Pick<Settings, 'set'>): Promise<void> {
  await settings.set(ONBOARDING_SETTING, true);
}
