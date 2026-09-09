import type { ReactNode } from 'react';

// Onboarding gets its own route group + full-screen layout — deliberately
// NOT under (hub), whose layout injects AppHeader + LayerRailNav (wrong
// chrome for a focused onboarding entrance). The root layout still wraps this with
// <html>/<body> + StudioProvider; here we only own the full-bleed canvas.
export const dynamic = 'force-dynamic';

export default function OnboardingLayout({ children }: { children: ReactNode }) {
  return (
    <div className="wizard-ambient h-screen w-screen overflow-y-auto">{children}</div>
  );
}
