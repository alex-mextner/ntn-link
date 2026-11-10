import { App } from '@/components/App';
import { Wordmark } from '@/components/Wordmark';
import { en } from '@/lib/client/strings';

/** Server-rendered shell; the only client component is <App />. */
export default function HomePage() {
  return (
    <main className="page">
      <header className="top">
        <Wordmark />
      </header>
      <section className="hero">
        <h1>
          {en.headlineLead} <span className="grad">{en.headlineAccent}</span>
        </h1>
        <p className="tagline">{en.tagline}</p>
      </section>
      <App />
      <footer className="foot">{en.footer}</footer>
    </main>
  );
}
