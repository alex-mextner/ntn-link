/** Deliberately minimal and replaceable: the real web UI lives in its own slice. */
export default function HomePage() {
  return (
    <main
      style={{
        maxWidth: 640,
        margin: '4rem auto',
        padding: '0 1rem',
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      <h1>ntn.link</h1>
      <p>
        Short links for public Notion pages. A link like <code>/workspace/my-page</code> unfurls in
        messengers with the page&apos;s real title, description and image, then sends readers to
        Notion.
      </p>
      <p>Create links with the CLI, the browser extension, or the HTTP API (see the README).</p>
    </main>
  );
}
