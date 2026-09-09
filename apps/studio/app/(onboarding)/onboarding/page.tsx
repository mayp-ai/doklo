import { OnboardingShell } from '../../../components/onboarding/shell';
import { wizardGetState } from '../../../lib/wizard-actions';

export const dynamic = 'force-dynamic';

export default async function OnboardingPage() {
  const state = await wizardGetState();
  return <OnboardingShell workspaceName={state.workspaceName} initialState={state} />;
}
