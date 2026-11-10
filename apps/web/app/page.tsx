import { App } from '@/components/App';
import { ru } from '@/lib/client/strings';

/** Server-rendered shell; the only client component is <App />. */
export default function HomePage() {
  return (
    <main className="page">
      <header className="header">
        <h1>{ru.appName}</h1>
        <p className="tagline">{ru.tagline}</p>
      </header>
      <App />
    </main>
  );
}
