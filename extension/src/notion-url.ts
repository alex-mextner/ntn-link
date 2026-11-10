/**
 * Classifies a string as a Notion page URL, reusing the server's parser so the extension
 * and the API agree on what a page id and a workspace are.
 */
import { canonicalNotionUrl, parseNotionUrl } from '../../packages/core/src/notion-url';

export interface ClassifiedPage {
  /** Null for `www.notion.so/<id>`-style URLs that name no workspace. */
  workspace: string | null;
  /** 32 lowercase hex characters, the form the API stores. */
  pageId: string;
  /** Query-free URL; the only form that is ever sent anywhere. */
  canonical: string;
}

export function classifyPageUrl(raw: string): ClassifiedPage | null {
  const text = raw.trim();
  // The server parser tolerates a bare "notion.so/..."; clipboard text that is not a
  // full URL is not something Notion's Copy link produces, so it is never rewritten.
  if (!/^https?:\/\//i.test(text)) return null;
  // The URL parser drops newlines, so two copied URLs would collapse into the last one's id.
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f]/.test(text)) return null;
  try {
    const { pageId, workspaceHint } = parseNotionUrl(text);
    return {
      workspace: workspaceHint,
      pageId,
      canonical:
        workspaceHint === null
          ? `https://www.notion.so/${pageId}`
          : canonicalNotionUrl(workspaceHint, pageId),
    };
  } catch {
    return null;
  }
}
