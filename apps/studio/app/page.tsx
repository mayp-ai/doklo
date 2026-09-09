import { redirect } from 'next/navigation';

// The Hub (`/doks`) is the canonical landing. Hitting the bare root
// sends you straight to the Hub.
export default function Home() {
  redirect('/doks');
}
