/** Notion's generic banners count as "no image"; real covers never do. */
import { describe, expect, test } from 'bun:test';
import {
  isNotionGeneratedCardUrl,
  isNotionPlaceholderImage,
  isNotionPlaceholderImageUrl,
} from '../src/notion-placeholder';

const wordmark = new Uint8Array(
  await Bun.file(new URL('./fixtures/notion-wordmark.png', import.meta.url)).arrayBuffer(),
);

// Recorded og:image values (2026-11-10), `&amp;` already decoded.
const GENERATED_CARD =
  'https://thsm.notion.site/image/attachment%3Aea853763-2e21-4363-90b1-5c3a82c34f3b%3ASocialMediaPreviewImage.png?table=block&id=413d447a-c4b1-8016-9985-c93eea7f02f9&spaceId=7289e276-56a4-4523-9606-77e96007ed51&width=2000&userId=&cache=v2&imgBuildSrc=pageMetadataCover';
const GALLERY_COVER =
  'https://thsm.notion.site/image/https%3A%2F%2Fthsm.notion.site%2Fimages%2Fpage-cover%2Fwebb2.jpg?table=block&id=319d447a-c4b1-8094-a402-cfbe020aeea7&spaceId=7289e276-56a4-4523-9606-77e96007ed51&width=2000&userId=&cache=v2&imgBuildSrc=pageMetadataCover';

describe('isNotionPlaceholderImageUrl', () => {
  test.each([
    ['the white Notion logo banner', 'https://thsm.notion.site/images/meta/notion-wordmark.png'],
    ['the marketing banner on the app host', 'https://app.notion.com/images/meta/default.png'],
    ['the marketing banner on www.notion.so', 'https://www.notion.so/images/meta/default.png'],
    ['any other file in the meta folder', 'https://thsm.notion.site/images/meta/whatever-2027.jpg'],
    [
      'a banner behind the image resizer',
      'https://thsm.notion.site/image/https%3A%2F%2Fwww.notion.so%2Fimages%2Fmeta%2Fdefault.png?width=1200',
    ],
  ])('%s', (_name, url) => {
    expect(isNotionPlaceholderImageUrl(url)).toBe(true);
  });

  test.each([
    ['a cover from Notion\u2019s gallery', GALLERY_COVER],
    [
      'an uploaded cover',
      'https://thsm.notion.site/image/attachment%3Aabc%3Ahotel.jpg?table=block&id=1&width=2000',
    ],
    [
      'an external cover behind the resizer',
      'https://thsm.notion.site/image/https%3A%2F%2Fimages.unsplash.com%2Fphoto-1.jpg?table=block&id=1',
    ],
    ['a meta-folder path on a foreign host', 'https://example.com/images/meta/default.png'],
    ['a look-alike host', 'https://notion.site.evil.example/images/meta/default.png'],
    [
      'a file merely named like the card in another folder',
      'https://thsm.notion.site/files/SocialMediaPreviewImage.png',
    ],
    ['garbage', 'not a url'],
  ])('%s is kept', (_name, url) => {
    expect(isNotionPlaceholderImageUrl(url)).toBe(false);
  });
});

describe('isNotionGeneratedCardUrl', () => {
  test('recognises the shape of the per-page "Made with Notion" card, a hint only', () => {
    expect(isNotionGeneratedCardUrl(GENERATED_CARD)).toBe(true);
    // The URL cannot say whether this is Notion's card or an upload under the same name, so it
    // is not a placeholder by itself.
    expect(isNotionPlaceholderImageUrl(GENERATED_CARD)).toBe(false);
  });

  test.each([
    ['a gallery cover', GALLERY_COVER],
    ['a banner', 'https://thsm.notion.site/images/meta/notion-wordmark.png'],
    ['a foreign host', 'https://example.com/image/attachment%3Aa%3ASocialMediaPreviewImage.png'],
    ['garbage', 'nope'],
  ])('%s is not it', (_name, url) => {
    expect(isNotionGeneratedCardUrl(url)).toBe(false);
  });
});

describe('isNotionPlaceholderImage (byte fingerprint)', () => {
  test('the recorded banner is recognised whatever URL it is served from', async () => {
    expect(await isNotionPlaceholderImage(wordmark)).toBe(true);
  });

  test('one changed byte is a different image', async () => {
    const edited = wordmark.slice();
    edited[edited.length - 1] = (edited[edited.length - 1] ?? 0) ^ 1;
    expect(await isNotionPlaceholderImage(edited)).toBe(false);
  });

  test('ordinary image bytes pass', async () => {
    expect(await isNotionPlaceholderImage(Uint8Array.of(0x89, 0x50, 0x4e, 0x47))).toBe(false);
  });
});
